/** Cold Session skill metadata and Host-only draft skill discovery. */

import { stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { realpathNormalize, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { z } from 'zod'
import type { SkillListRequest, SkillListValue } from './types.ts'

const draftId = z.string().refine(value => value.trim().length > 0)
const draftRequest = z.strictObject({
  workspaceId: draftId.optional(),
  agentPreset: draftId.optional(),
})

const draftErrorMessages = {
  DRAFT_SKILL_INVALID_REQUEST: 'Invalid draft skill request',
  DRAFT_SKILL_INVALID_WORKSPACE: 'Draft skill preview requires a registered Workspace directory',
  DRAFT_SKILL_PRESET_NOT_FOUND: 'Draft skill preset was not found',
  DRAFT_SKILL_PRESET_INVALID: 'Draft skill preset could not be used',
  DRAFT_SKILL_UNAVAILABLE: 'Draft skill preview is unavailable',
  ABORTED: 'Draft skill preview was cancelled',
} as const

class DraftSkillPreviewError extends HarnessError {
  constructor(code: keyof typeof draftErrorMessages) {
    super(draftErrorMessages[code], code)
    if (code === 'ABORTED') this.name = 'AbortError'
  }
}

type DraftSkill = { name: string; scope: 'user' | 'project' }

async function isWorkspaceSkill(cwd: string, path: string): Promise<boolean> {
  let canonical: string
  try {
    canonical = await realpathNormalize(path)
  } catch (_error) {
    // An unverified skill path cannot establish Workspace containment.
    return false
  }
  const location = relative(cwd, canonical)
  return location !== '' && location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert', 'workingDirectory']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    const { sessionId } = request
    let cwd: string
    let agentPreset: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.projections.values.workingDirectory
        ?? observation.header.cwd
        ?? this.ctx.workingDirectory.defaultDirectory
      agentPreset = observation.projections.values.agentPreset ?? undefined
      const live = this.ctx.agents.get(sessionId)
      if (live !== undefined) cwd = await this.ctx.workingDirectory.ensure(live, signal)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    await using lease = live === undefined ? await this.scopeFor(agentPreset) : undefined
    const scope = live ?? lease?.key
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      return {
        skills: skills.map(skill => ({
          name: skill.name,
          ...skill.path === undefined ? {} : { path: skill.path },
          description: skill.description,
          ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
          modelInvocable: skill.invocation.modelInvocable,
        })),
      }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /**
   * Preview native user skill names for a draft without creating an Agent or Session.
   * @param request - Optional registered Workspace ID and preset ID. Without a Workspace, discovery omits `cwd`.
   * @param signal - Cancels discovery. A cancelled request publishes no partial list.
   * @returns The names and scopes of eligible winners. A composition without native `/name` handling returns an empty list.
   * @throws DraftSkillPreviewError with a fixed code and message for invalid input, unavailable discovery, or cancellation.
   */
  async previewDraft(
    request: { workspaceId?: string; agentPreset?: string },
    signal: AbortSignal,
  ): Promise<{ skills: readonly DraftSkill[] }> {
    try {
      signal.throwIfAborted()
      const parsed = draftRequest.safeParse(request)
      if (!parsed.success) throw new DraftSkillPreviewError('DRAFT_SKILL_INVALID_REQUEST')
      const { workspaceId, agentPreset } = parsed.data
      const cwd = workspaceId === undefined ? undefined : await this.draftDirectory(workspaceId)
      signal.throwIfAborted()
      const skills = await this.draftSkills(agentPreset, cwd, signal)
      signal.throwIfAborted()
      if (workspaceId !== undefined && await this.draftDirectory(workspaceId) !== cwd) {
        throw new DraftSkillPreviewError('DRAFT_SKILL_INVALID_WORKSPACE')
      }
      signal.throwIfAborted()
      return { skills }
    } catch (error) {
      if (signal.aborted) throw new DraftSkillPreviewError('ABORTED')
      if (error instanceof DraftSkillPreviewError) throw error
      throw new DraftSkillPreviewError('DRAFT_SKILL_UNAVAILABLE')
    }
  }

  private async draftDirectory(workspaceId: string): Promise<string> {
    const workspace = this.ctx.get('workspaceRegistry')?.get(WorkspaceId(workspaceId))
    if (workspace !== undefined) {
      try {
        const canonical = await realpathNormalize(workspace.path)
        if (canonical === workspace.path && (await stat(canonical)).isDirectory()
          && this.ctx.get('workspaceRegistry')?.get(workspace.id)?.path === canonical) return canonical
      } catch (_error) {
        // Filesystem diagnostics may contain Host paths. The caller receives only the Workspace failure code.
        throw new DraftSkillPreviewError('DRAFT_SKILL_INVALID_WORKSPACE')
      }
    }
    throw new DraftSkillPreviewError('DRAFT_SKILL_INVALID_WORKSPACE')
  }

  private async draftSkills(agentPreset: string | undefined, cwd: string | undefined, signal: AbortSignal): Promise<DraftSkill[]> {
    await using lease = await this.draftScope(agentPreset)
    signal.throwIfAborted()
    const registry = lease?.serviceFor('skills') ?? this.ctx.get('skills')
    const scope = lease?.key
    if (registry === undefined || !registry.hasUserInvocation(scope)) return []

    const skills: DraftSkill[] = []
    const winners = await registry.list({ ...cwd === undefined ? {} : { cwd }, scope, signal })
    for (const skill of winners) {
      signal.throwIfAborted()
      if (!isUserInvocable(skill)) continue
      switch (skill.source) {
        case 'user-dsh':
        case 'user-agents':
          skills.push({ name: skill.name, scope: 'user' })
          break
        case 'project-dsh':
        case 'project-agents':
          if (cwd !== undefined && skill.path !== undefined && await isWorkspaceSkill(cwd, skill.path)) {
            skills.push({ name: skill.name, scope: 'project' })
          }
          break
        default:
          // Other providers may serve Sessions but are outside draft discovery.
          break
      }
    }
    return skills
  }

  private async draftScope(agentPreset: string | undefined) {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      if (agentPreset !== undefined) throw new DraftSkillPreviewError('DRAFT_SKILL_PRESET_NOT_FOUND')
      return undefined
    }
    try {
      return await presets.acquireScope(agentPreset)
    } catch (error) {
      const code = remoteErrorOf(error)?.code
      if (code === 'agent-preset/not-found') throw new DraftSkillPreviewError('DRAFT_SKILL_PRESET_NOT_FOUND')
      if (code === 'agent-preset/invalid') throw new DraftSkillPreviewError('DRAFT_SKILL_PRESET_INVALID')
      throw error
    }
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    agentPreset: string | undefined,
  ): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.acquireScope(agentPreset)
    } catch {
      // An unknown or unusable recorded preset falls back to the global registry.
      return undefined
    }
  }
}

export default SessionSkillCatalog
