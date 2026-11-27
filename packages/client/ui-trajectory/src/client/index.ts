/**
 * Browser trajectory plugin contributing one entry to the conversation view
 * slot without defining a service.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionBinding, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { createToolResultWatcher } from './watch-tool-result.ts'
import { createTrajectoryDurationStore } from './duration-store.ts'
import { createTrajectoryStringWrappingStore } from './string-wrapping-store.ts'
import { en, ja, es, fr, de, ru, pt, NS, zh } from './locales.ts'
import { registerTrajectoryAssistantDefinition } from './trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from './trajectory-compaction-definition.ts'
import { registerTrajectoryMessageDefinitions } from './trajectory-message-definitions.ts'
import { registerTrajectoryRequestHeaderDefinition } from './trajectory-request-header-definition.ts'
import {
  EMPTY_TRAJECTORY_SNAPSHOT, registerTrajectoryConversationView,
} from './trajectory-snapshot-builder.ts'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { toolResultIdentity } from './trajectory-record.ts'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import { registerTrajectoryToolDefinition } from './trajectory-tool-definition.ts'
import { TrajectoryView, type TrajectoryViewInjected } from './TrajectoryView.tsx'

export type { TrajectoryKey } from './locales.ts'
export type {
  TrajectoryContribution,
  TrajectoryConversationViewNode,
  TrajectoryRequestHeaderState,
  TrajectorySnapshot,
  UseTrajectory,
} from './trajectory-contract.ts'

function containsResult(calls: readonly ToolCallBlock[], identity: object): boolean {
  return calls.some(call => ('kind' in call && toolResultIdentity(call) === identity)
    || containsResult(call.subCalls, identity))
}

function historyAvailability(snapshot: SessionSnapshot) {
  return snapshot.historyAvailability ?? (snapshot.openState === 'open' ? 'confirmed' : 'unavailable')
}

function waitForConfirmedHistory(session: SessionBinding['session'], signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      stop()
      signal.removeEventListener('abort', abort)
      resolve(ready)
    }
    const abort = () => { finish(false) }
    const check = () => {
      const snapshot = session.getSnapshot()
      const state = historyAvailability(snapshot)
      if (signal.aborted || state === 'unavailable' || snapshot.openState === 'error' || snapshot.removed) finish(false)
      else if (state === 'confirmed' && snapshot.openState === 'open') finish(true)
    }
    const stop = session.subscribe(check)
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

/** Required services: the conversation slot, registries, ordinary Session paging, and the locale service. */
export const inject = ['slots', 'sessions', 'uiSession', 'uiConversation', 'locale', 'remote', 'remote.toolResults']

/**
 * Client plugin body: register the trajectory view tab. The registration
 * rides the slot service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const watcherLifetime = new AbortController()
  const closingWatches = new Set<Promise<void>>()
  const watcherOwner = {
    signal: watcherLifetime.signal,
    trackClosing: (task: Promise<void>) => {
      closingWatches.add(task)
      const forget = () => { closingWatches.delete(task) }
      void task.then(forget, forget)
    },
  }
  ctx.effect(() => async () => {
    watcherLifetime.abort()
    await Promise.allSettled(closingWatches)
  })
  const trajectorySources = new WeakMap<SessionBinding, ObservableSnapshot<TrajectorySnapshot>>()
  const trajectorySource = (binding: SessionBinding): ObservableSnapshot<TrajectorySnapshot> => {
    let source = trajectorySources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('trajectory')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_TRAJECTORY_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      trajectorySources.set(binding, source)
    }
    return source
  }
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-trajectory: dictionaries')
  // Registration-time text (the view tab label) reads through the bound
  // translate as a thunk, so it follows the active locale without
  // re-registration.
  const t = ctx.locale.bind(NS)
  const duration = createTrajectoryDurationStore()
  const stringWrapping = createTrajectoryStringWrappingStore()
  registerTrajectoryMessageDefinitions(ctx)
  registerTrajectoryRequestHeaderDefinition(ctx)
  registerTrajectoryAssistantDefinition(ctx)
  registerTrajectoryToolDefinition(ctx)
  registerTrajectoryCompactionDefinitions(ctx)
  registerTrajectoryConversationView(ctx)
  ctx.uiSession.provide({
    hooks: ['trajectory'],
    resolve: binding => ({ hooks: { trajectory: trajectorySource(binding) } }),
  })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'trajectory',
    order: 10,
    locale: NS,
    label: () => t('view.trajectory'),
    children: { 'conversation.trajectory.images': { kind: 'single', scope: 'session' } },
    inject: (sessionId: SessionId): TrajectoryViewInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) {
        throw new Error(`ui-trajectory: session "${sessionId}" is unavailable`)
      }
      const { session } = binding
      const trajectory = ctx.uiConversation.binding(binding).target('trajectory')
      return {
        hooks: { duration },
        watchToolResult: createToolResultWatcher(ctx.remote, sessionId, (error) => {
          ctx.logger.warn('live tool result unavailable: %s', error)
        }, {
          waitUntilConfirmed: signal => waitForConfirmedHistory(session, signal),
          isCurrent: (identity) => {
            const current = session.getSnapshot()
            if (ctx.sessions.binding(sessionId) !== binding || current.openState !== 'open'
              || historyAvailability(current) !== 'confirmed' || identity === undefined) return false
            const snapshot = trajectory.getSnapshot()
            return snapshot !== undefined
              && (snapshot.eventNodes.some(node => node.kind === 'tool-result' && containsResult([node], identity))
                || containsResult(snapshot.runningCalls, identity))
          },
        }, watcherOwner),
        jsonStringWrapping: {
          getDefault: () => stringWrapping.getSnapshot(),
          setDefault: (value) => { stringWrapping.set(value) },
        },
        readingPosition: epoch => session.getSnapshot().historyEpoch === epoch
          ? session.readingPosition?.('trajectory') : undefined,
        loadThrough: seq => session.loadThrough(seq),
        loadOlder: async () => {
          const before = trajectory.getSnapshot()
          await session.loadOlder()
          return trajectory.getSnapshot() !== before
        },
        loadImage: Object.assign(
          (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
          { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
        ),
        setActualDuration: (value) => { duration.set(value) },
      }
    },
  }, TrajectoryView))
}
