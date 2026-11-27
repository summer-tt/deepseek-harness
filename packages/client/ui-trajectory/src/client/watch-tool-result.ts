/** Selected-result subscriptions retain no history-sized Client cache. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionToolResultValue } from '../types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Observe one result until the inspector releases it; undefined denotes unavailable. */
export type WatchToolResult = (seq: number, publish: (value: JsonValue | undefined) => void, identity?: object) => () => void

/**
 * Bind an ephemeral inspector stream to one Session.
 * @param remote - Generated Remote transport and reconnecting stream owner.
 * @param sessionId - Session inspected by this view.
 * @param report - Diagnostic sink for unavailable transport and teardown failures.
 * @param authority - wait for authorization on reconnect and validate the selected result against current history.
 * @param owner - plugin signal and teardown tracking for subscriptions that are closing.
 * @returns Subscription factory; closing a subscription releases its selected value.
 */
export function createToolResultWatcher(
  remote: Pick<ClientRemote, '$stream' | 'toolResults'>,
  sessionId: SessionId,
  report: (error: unknown) => void,
  authority?: {
    readonly waitUntilConfirmed: (signal: AbortSignal) => Promise<boolean>
    readonly isCurrent: (identity: object | undefined) => boolean
  },
  owner?: { readonly signal: AbortSignal; readonly trackClosing: (task: Promise<void>) => void },
): WatchToolResult {
  return (seq, publish, identity) => {
    const signal = owner?.signal
    if (signal?.aborted) return () => {}
    const lifetime = { stopped: false, refused: false }
    const clear = (): void => { if (!lifetime.stopped) publish(undefined) }
    const stream = remote.$stream<SessionToolResultValue>({
      name: 'live tool result',
      open: async function* (signal) {
        if (authority !== undefined && (!await authority.waitUntilConfirmed(signal) || !authority.isCurrent(identity))) {
          lifetime.refused = true
          return
        }
        if (!signal.aborted) yield* remote.toolResults.watch({ sessionId, seq }, signal)
      },
      ended: () => new Error('live tool result stream ended'),
      carrierFailed: clear,
    })
    const dispose = () => {
      if (lifetime.stopped) return
      lifetime.stopped = true
      signal?.removeEventListener('abort', dispose)
      const closing = stream.dispose().catch(report)
      owner?.trackClosing(closing)
    }
    signal?.addEventListener('abort', dispose, { once: true })
    void (async () => {
      try {
        for await (const frame of stream) {
          if (lifetime.stopped) return
          frame.accept()
          if (authority === undefined || authority.isCurrent(identity)) {
            publish(frame.value.available ? frame.value.value : undefined)
          }
        }
      } catch (error: unknown) {
        if (!lifetime.stopped && !lifetime.refused) { clear(); report(error) }
      } finally {
        signal?.removeEventListener('abort', dispose)
        clear()
      }
    })()
    return dispose
  }
}
