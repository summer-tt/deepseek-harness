/** Web opening aggregation over one observation and a shared transforming buffer. */

import type { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type { HistoryController } from '../history/controller.ts'
import { addressId, entryFor, rejectNotFound } from '../history.ts'
import { EventListener, ListenerBuffer } from '../history/listener.ts'
import { history, projections, resolveHistoryRequest, validateObservationAddress } from '../history/controller.ts'
import type { SessionEventsPage, SessionFollowFrame, SessionFollowRequest } from '../types.ts'

const MAX_EXPANDED_RECORDS = 1_500
const MAX_EXPANDED_JSON_BYTES = 2 * 1024 * 1024

/** Combines opening data and consumes transformed listener output from one queue. */
export class WebController {

  /**
   * @param ctx - Host context carrying Session queries and identity projections.
   * @param historyController - passive reading and listener construction.
   * @param promote - background activation requested before an opening snapshot is delivered.
   */
  constructor(
    private readonly ctx: Context,
    private readonly historyController: HistoryController,
    private readonly promote: (observation: SessionObservation) => void,
  ) {}

  /**
   * Open a history snapshot and follow uncovered history and assistant notifications.
   * @param request - Session identity, page budget, assistant output and optional activation (default false).
   * @param signal - cancellation for opening and streaming.
   * @returns an opening snapshot followed by uncovered queued increments.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    const sessionId = addressId(request.address)
    const spec = resolveHistoryRequest(request)
    const start = request.historyWindowStart
    if (start !== undefined && (!Number.isSafeInteger(start) || start < 0 || Object.is(start, -0))) {
      throw new RemoteError('gateway/bad-request', 'historyWindowStart must be a non-negative safe integer', {})
    }
    using queue = new ListenerBuffer<SessionFollowFrame>(this.ctx, signal)
    using listener = new EventListener(this.ctx, sessionId, signal, queue)
    const streams = this.historyController.streamsListener
    using assistantListener = request.assistantStream === true
      ? streams.bind(sessionId, signal, queue)
      : undefined
    using observation = await this.historyController.usingObservation({ sessionId, projection: true }, signal)
      .catch((error: unknown) => {
        if (remoteErrorOf(error)?.code === 'session/not-found') rejectNotFound(request.address)
        throw error
      })
    validateObservationAddress(request.address, observation)
    let opening: SessionFollowFrame = {
      type: 'snapshot',
      header: { ...observation.header },
      projections: projections(observation),
      ...expandOpeningHistory(observation, history(observation, spec), start),
    }
    listener.setCursor(opening.cursor)
    if (assistantListener !== undefined) {
      const { baseline: assistantStream, ordinal } = assistantListener.snapshot()
      opening = { ...opening, assistantStream }
      assistantListener.setOrdinalCut(ordinal)
    }
    // Increments come from the queue, so the opening ends this lease in every branch;
    // activation continues on its own retained lease. Promotion starts before the opening is
    // delivered, so a consumer that stops after the snapshot still gets the activation it asked for.
    if (request.activate === true && !signal.aborted
      && observation.header.origin !== 'subagent' && observation.source === 'prepared') {
      const promotion = observation.retain()
      observation[Symbol.dispose]()
      try {
        this.promote(promotion)
      } catch (error: unknown) {
        promotion[Symbol.dispose]()
        throw error
      }
    } else {
      observation[Symbol.dispose]()
    }
    yield opening
    yield* queue.items()
  }
}

/** Reuse the default page and its observation when an earlier opening start fits. */
function expandOpeningHistory(
  observation: SessionObservation,
  page: SessionEventsPage,
  start: number | undefined,
): SessionEventsPage {
  const first = page.records[0]?.event.seq
  if (start === undefined || first === undefined || start >= first) return page
  const count = page.cursor - start + 1
  if (count > MAX_EXPANDED_RECORDS) return page

  const older = observation.events.slice(start, first).map(entryFor)
  const records = [...older, ...page.records]
  // Include JSON array delimiters and separators. A rejected expansion keeps the complete default page.
  let remaining = MAX_EXPANDED_JSON_BYTES - (count + 1)
  for (const record of records) {
    if (!fitsJsonLowerBound(record, remaining)) return page
    remaining -= Buffer.byteLength(JSON.stringify(record))
    if (remaining < 0) return page
  }
  return { ...page, records, hasMore: start > 0 }
}

/** Bound serialization work before allocating JSON for one committed record. */
function fitsJsonLowerBound(value: unknown, remaining: number): boolean {
  const ancestors: Iterator<unknown, void>[] = []
  let current = value
  for (;;) {
    remaining -= typeof current === 'string' ? current.length + 2 : 1
    if (remaining < 0) return false
    if (typeof current === 'object' && current !== null) {
      ancestors.push(jsonChildren(current))
    }
    for (;;) {
      const children = ancestors.at(-1)
      if (children === undefined) return true
      const next = children.next()
      if (!next.done) {
        current = next.value
        break
      }
      ancestors.pop()
    }
  }
}

function* jsonChildren(value: object): Generator<unknown, void> {
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    if (!Array.isArray(value)) yield key
    yield Reflect.get(value, key)
  }
}
