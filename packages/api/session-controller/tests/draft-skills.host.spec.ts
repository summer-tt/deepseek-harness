/** Draft skill discovery through real standing preset and skill registrations. */
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets, { type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionSkillCatalog } from '../src/skill-catalog.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  }
})

async function writeSkill(root: string, name: string, policy = ''): Promise<void> {
  const path = join(root, name, 'SKILL.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `---\nname: ${name}\ndescription: Test skill description\n${policy}---\n\nPrivate instructions for ${name}.\n`)
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  const temp = await mkdtemp(join(tmpdir(), 'dsh-draft-skills-'))
  directories.push(temp)
  const root = await realpath(temp)
  const repo = join(root, 'repo')
  const isolated = join(root, 'isolated')
  const nested = join(repo, 'nested')
  const users = join(root, 'dsh-home')
  const agents = join(root, 'agents-home')
  const bundled = join(root, 'bundled')
  const custom = join(root, 'custom')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(nested)
  await Promise.all([
    writeSkill(join(users, 'skills'), 'user-review', 'disable-model-invocation: true\n'),
    writeSkill(join(users, 'skills'), 'shadowed'),
    writeSkill(join(agents, 'skills'), 'shared-review'),
    writeSkill(join(repo, '.agents/skills'), 'project-review'),
    writeSkill(join(repo, '.dsh/skills'), 'local-review'),
    writeSkill(join(repo, '.agents/skills'), 'shadowed', 'user-invocable: false\n'),
    writeSkill(bundled, 'bundled-skill'),
    writeSkill(custom, 'custom-skill'),
    writeSkill(join(isolated, 'skills'), 'isolated-review'),
  ])

  await mountAgentLoopTestDependencies(ctx)
  provideWorkingDirectoryFixture(ctx, nested)
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({ name: 'runtime-skill', source: 'runtime', description: 'Private', content: 'Private' })
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.skillRegistry = SkillRegistry
  ctx.loader.builtins.skillFilesystem = SkillFilesystem
  ctx.loader.builtins.toolSkill = ToolSkill
  await ctx.plugin(AgentPresets, { default: 'standard' })
  const filesystem = { name: 'cordis:skillFilesystem', config: { dshHome: users, agentsHome: agents, bundledSkillDir: bundled, customSkillDirs: [custom], watch: false } }
  const tool = { name: 'cordis:toolSkill' }
  const declare = async (id: string, plugins: PresetDefinition['plugins']) => {
    return await ctx.plugin({ inject: ['agentPresets'], async* apply(owner: Context) {
      yield await owner.agentPresets.register({ id, plugins })
    } })
  }
  const standard = await declare('standard', [filesystem, tool])
  await declare('disabled', [filesystem, { ...tool, disabled: true }])
  await declare('isolated', [{
    name: 'cordis:group', group: true, isolate: { skills: true }, config: [
      { name: 'cordis:skillRegistry' },
      { ...filesystem, config: { ...filesystem.config, dshHome: isolated } },
      tool,
    ],
  }])
  ctx.loader.builtins.broken = () => { throw new Error(`Private preset error ${repo}`) }
  await declare('broken', [{ name: 'cordis:broken' }])

  const paths = new Map([['repo', repo], ['nested', nested]])
  ctx.provide('workspaceRegistry', { get: (id: string) => {
    const path = paths.get(id)
    return path === undefined ? undefined : { id: WorkspaceId(id), path }
  } } as never)
  const create = vi.spyOn(ctx.agents, 'create')
  const signal = new AbortController().signal
  const catalog = new SessionSkillCatalog(ctx)
  return { ctx, repo, nested, root, paths, create, catalog, signal, standard }
}

it('returns only eligible winners, and uses the same project shadow as native first-message invocation', async () => {
  const { catalog, ctx, repo, create, signal } = await harness()
  const load = vi.spyOn(ctx.skills, 'get')
  await expect(catalog.previewDraft({ workspaceId: 'repo' }, signal)).resolves.toEqual({ skills: [
    { name: 'local-review', scope: 'project' },
    { name: 'project-review', scope: 'project' },
    { name: 'shared-review', scope: 'user' },
    { name: 'user-review', scope: 'user' },
  ] })
  expect(create).not.toHaveBeenCalled()
  expect(load).not.toHaveBeenCalled()
  expect(ctx.sessions.list()).toEqual([])

  const session = ctx.sessions.create(SessionId('native-first-prompt'), { meta: { cwd: repo } })
  const agent = { id: session.id, session } as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  await ctx.agentPresets.mount(scope.ctx)
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/project-review /shadowed' }] })
  const result = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [message], signal, turn: 1, step: 1, modelSelection: { provider: 'test', model: 'test' },
  }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))
  expect(result.kind).toBe('enter')
  if (result.kind !== 'enter') throw new Error('Expected the first prompt to enter')
  const invocation = result.messages.filter(item => item.source.kind === 'skill-invocation')
  expect(invocation).toHaveLength(1)
  expect(invocation[0]?.source).toMatchObject({ name: 'project-review' })
  expect(invocation[0]?.content[0]).toMatchObject({ text: expect.stringContaining('Private instructions for project-review.') })
})

it('uses isolated scoped registries and requires the native listener even when skills can be discovered', async () => {
  const { catalog, ctx, signal, standard } = await harness()
  const list = vi.spyOn(ctx.skills, 'list')
  await expect(catalog.previewDraft({ agentPreset: 'disabled' }, signal)).resolves.toEqual({ skills: [] })
  expect(list).not.toHaveBeenCalled()
  await expect(catalog.previewDraft({ agentPreset: 'isolated' }, signal)).resolves.toEqual({ skills: [
    { name: 'isolated-review', scope: 'user' },
    { name: 'shared-review', scope: 'user' },
  ] })
  expect(list).not.toHaveBeenCalled()
  await using lease = await ctx.agentPresets.acquireScope()
  expect(ctx.skills.hasUserInvocation(lease.key)).toBe(true)
  await standard.dispose()
  expect(ctx.skills.hasUserInvocation(lease.key)).toBe(true)
  await lease[Symbol.asyncDispose]()
  expect(ctx.skills.hasUserInvocation(lease.key)).toBe(false)
})

it('omits cwd without a Workspace and excludes the parent repository and sibling paths', async () => {
  const { catalog, ctx, repo, signal } = await harness()
  const list = vi.spyOn(ctx.skills, 'list')
  const users = { skills: [
    { name: 'shared-review', scope: 'user' },
    { name: 'user-review', scope: 'user' },
  ] }
  await expect(catalog.previewDraft({ workspaceId: 'nested' }, signal)).resolves.toEqual(users)
  expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: join(repo, 'nested'), signal }))
  await expect(catalog.previewDraft({}, signal)).resolves.toEqual({ skills: [
    { name: 'shadowed', scope: 'user' }, ...users.skills,
  ] })
  expect(list.mock.calls.at(-1)?.[0]).not.toHaveProperty('cwd')
})

it('excludes a project skill whose symlink resolves outside its registered Workspace', async () => {
  const { catalog, repo, root, signal } = await harness()
  const target = join(root, 'repo-sibling')
  await writeSkill(target, 'escaped')
  await symlink(join(target, 'escaped'), join(repo, '.agents/skills/escaped'), 'junction')
  const { skills } = await catalog.previewDraft({ workspaceId: 'repo' }, signal)
  expect(skills.map(skill => skill.name)).toEqual(['local-review', 'project-review', 'shared-review', 'user-review'])
})

it('rejects invalid requests, stale Workspace paths, and unavailable presets without identifying Host files', async () => {
  const { catalog, ctx, nested, root, paths, signal } = await harness()
  const list = vi.spyOn(ctx.skills, 'list')
  for (const request of [{ cwd: root }, { workspaceId: '' }, { agentPreset: '   ' }, { workspaceId: 42 }, null, []]) {
    await expect(Reflect.apply(catalog.previewDraft, catalog, [request, signal]))
      .rejects.toMatchObject({ code: 'DRAFT_SKILL_INVALID_REQUEST' })
  }
  await rename(nested, join(root, 'moved'))
  const file = join(root, 'plain-file')
  await writeFile(file, 'test')
  paths.set('file', file)
  paths.set('relative', '.')
  for (const workspaceId of [root, 'nested', 'file', 'relative']) {
    await expect(catalog.previewDraft({ workspaceId }, signal)).rejects.toMatchObject({
      code: 'DRAFT_SKILL_INVALID_WORKSPACE', message: 'Draft skill preview requires a registered Workspace directory',
    })
  }
  await symlink(join(root, 'moved'), nested, 'junction')
  await expect(catalog.previewDraft({ workspaceId: 'nested' }, signal)).rejects.toMatchObject({ code: 'DRAFT_SKILL_INVALID_WORKSPACE' })
  await expect(catalog.previewDraft({ agentPreset: root }, signal)).rejects.toMatchObject({
    code: 'DRAFT_SKILL_PRESET_NOT_FOUND', message: 'Draft skill preset was not found',
  })
  await expect(catalog.previewDraft({ agentPreset: 'broken' }, signal)).rejects.toMatchObject({
    code: 'DRAFT_SKILL_PRESET_INVALID', message: 'Draft skill preset could not be used',
  })
  expect(list).not.toHaveBeenCalled()
})

it('revalidates a Workspace removed during discovery and redacts provider failure details', async () => {
  const { catalog, ctx, paths, root, signal } = await harness()
  vi.spyOn(ctx.skills, 'list').mockImplementationOnce(async () => {
    paths.delete('repo')
    return []
  }).mockRejectedValueOnce(new Error(root))
  await expect(catalog.previewDraft({ workspaceId: 'repo' }, signal)).rejects.toMatchObject({ code: 'DRAFT_SKILL_INVALID_WORKSPACE' })
  const failure = catalog.previewDraft({}, signal)
  await expect(failure).rejects.toMatchObject({
    code: 'DRAFT_SKILL_UNAVAILABLE', message: 'Draft skill preview is unavailable',
  })
  await expect(failure).rejects.not.toHaveProperty('cause')
  await expect(failure).rejects.not.toHaveProperty('details')
})

it('cancels before starting or during a provider read without exposing the caller reason', async () => {
  const { catalog, ctx, root, create } = await harness()
  const entered = Promise.withResolvers<undefined>()
  const pending = Promise.withResolvers<[]>()
  const list = vi.fn(() => {
    entered.resolve(undefined)
    return pending.promise
  })
  ctx.skills.registerProvider((control) => {
    control.signal.addEventListener('abort', () => { pending.resolve([]) }, { once: true })
    return { name: 'blocked-provider', list, get: () => Promise.resolve(undefined) }
  })
  const expected = { code: 'ABORTED', name: 'AbortError', message: 'Draft skill preview was cancelled' }
  await expect(catalog.previewDraft({}, AbortSignal.abort(new Error(root)))).rejects.toMatchObject(expected)
  expect(list).not.toHaveBeenCalled()
  const cancel = new AbortController()
  const result = catalog.previewDraft({}, cancel.signal)
  await entered.promise
  cancel.abort(new Error(root))
  await expect(result).rejects.toMatchObject(expected)
  expect(create).not.toHaveBeenCalled()
})
