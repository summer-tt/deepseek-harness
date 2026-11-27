/** Session-specific adapters for Gateway-owned Remote stream lifecycles. */

import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteJournalStream,
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
  type ClientRemote,
  type RemoteJournalChange,
  type RemoteJournalFrame,
} from '@deepseek-ai/dsh-api-gateway/client'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionControlFrame,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionWireHeader,
} from '../types.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
} from './sessions/history-records.ts'
import type { HistoryAuthorization } from './sessions/history-cache.ts'
import type { SessionLiveEventEntry } from './contract/events.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import { assertSessionWireEvent } from './session-wire-event.ts'

export {
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '../types.ts'

/** Pagination fields bound to an already-addressed Session journal. */
export type ClientSessionPageRequest = Omit<SessionPageRequest, 'address' | 'throughSeq' | 'historyRouteEpoch' | 'verifiedHistoryWindow'>

/** Complete generated `ctx.remote.session` namespace. */
export type SessionRemote = ClientRemote['session']

/** Opening metadata carried only by a follow snapshot, never by loadOlder pages. */
interface SessionJournalPage extends SessionPage {
  readonly authority: boolean
  readonly authorization?: HistoryAuthorization
  readonly header?: SessionWireHeader
  readonly projections?: SessionProjectionBaseline
  readonly assistantStream?: SessionAssistantStreamBaseline
}

/** One complete publication from the Session journal stream. */
export type SessionJournalChange =
  | {
    readonly type: 'replace' | 'prepend'
    readonly page: SessionJournalPage
    readonly entries: readonly SessionLiveEventEntry[]
    readonly hasMore: boolean
  }
  | { readonly type: 'append'; readonly entry: SessionLiveEventEntry }
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }

function toSessionJournalChange(
  change: RemoteJournalChange<
    SessionJournalPage, SessionHistoryRecord, SessionAssistantStreamFrame
  >,
): SessionJournalChange {
  switch (change.type) {
    case 'replace':
    case 'prepend':
      return { ...change, entries: historyEntries(change.entries) }
    case 'append': {
      return {
        type: 'append',
        entry: change.entry as unknown as SessionLiveEventEntry,
      }
    }
    case 'notification':
      return { type: 'assistant-stream', frame: change.notification }
  }
}

type SessionControlBaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
type SessionControlDeltaFrame = Exclude<SessionControlFrame, SessionControlBaselineFrame>

/** Gateway-owned control snapshot stream configured for Session frames. */
export type SessionControlStream = RemoteSnapshotStream<
  SessionControlBaselineFrame,
  SessionControlDeltaFrame
>

/** Domain sinks used by the Host-wide Session control stream. */
export interface SessionControlStreamOptions {
  /** Apply a complete baseline or one later update. */
  readonly accept: (frame: SessionControlFrame) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/** Domain sinks used by one addressed Session event journal. */
export interface SessionEventStreamOptions {
  /** Resolve the current verified grant and the start of the visible durable window. */
  readonly history?: () => { readonly authorization: HistoryAuthorization; readonly start?: number } | undefined
  /** Apply one complete event-window change. */
  readonly publish: (change: SessionJournalChange) => void
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal stream, page, or protocol failure after opening. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the Host-wide Session control snapshot stream.
 * @param remote - generated Session namespace and Gateway stream factory.
 * @param options - Session state destinations.
 * @returns an unstarted stream owned by the Client Session runtime.
 */
export function createSessionControlStream(
  remote: SessionRemotes,
  options: SessionControlStreamOptions,
): SessionControlStream {
  const stream = remote.$stream<SessionControlFrame>({
    name: 'session control stream',
    open: signal => remote.session.control(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('session control stream ended without a terminal result')
      : new Error('session control stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream(stream, {
    name: 'session control stream',
    isSnapshot: (frame): frame is SessionControlBaselineFrame => frame.type === 'baseline',
    replace: options.accept,
    update: options.accept,
    failed: options.failed,
  })
}

/** Gateway-owned event journal bound to one ordinary or direct-subagent Session address. */
export class SessionEventStream extends RemoteJournalStream<
  SessionJournalPage,
  SessionHistoryRecord,
  number,
  ClientSessionPageRequest,
  SessionAssistantStreamFrame
> {
  private followAuthorization: HistoryAuthorization | undefined
  private requestedAuthorization: HistoryAuthorization | undefined

  /** The authority captured at dispatch, including when an opening rejects before its first frame. */
  get requestAuthority(): HistoryAuthorization | undefined { return this.requestedAuthorization }

  /**
   * @param remote - generated Session namespace and Gateway stream factory.
   * @param address - durable ordinary-Session or direct-subagent address.
   * @param options - Session event-window destinations.
   */
  constructor(
    private readonly remote: SessionRemotes,
    private readonly address: SessionAddress,
    private readonly sessionOptions: SessionEventStreamOptions,
  ) {
    super(remote, {
      name: 'session event stream',
      emptyCursor: -1,
      entries: page => page.records,
      hasMore: page => page.hasMore,
      allowRewind: page => page.authority,
      first: historyRecordFirstSeq,
      last: historyRecordLastSeq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => { sessionOptions.publish(toSessionJournalChange(change)) },
      ...(sessionOptions.carrierFailed === undefined
        ? {}
        : { carrierFailed: sessionOptions.carrierFailed }),
      failed: sessionOptions.failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    request: ClientSessionPageRequest,
    signal: AbortSignal,
  ): AsyncIterable<RemoteJournalFrame<
    SessionHistoryRecord, number, SessionJournalPage, SessionAssistantStreamFrame
  >> {
    let assistantRevision: number | undefined
    const history = this.sessionOptions.history?.()
    const authorization = history?.authorization
    this.requestedAuthorization = authorization
    for await (const frame of this.remote.session.follow({
      address: this.address,
      activate: true,
      assistantStream: true,
      ...this.repairRequest(request),
      ...verifiedFields(authorization),
      ...(history?.start === undefined ? {} : { historyWindowStart: history.start }),
    }, signal)) {
      signal.throwIfAborted()
      if (authorization !== undefined && this.sessionOptions.history?.()?.authorization !== authorization) {
        throw new RemoteStreamCarrierError('session history authorization changed during follow')
      }
      if (frame.type === 'snapshot') {
        if (authorization !== undefined) assertOpening(this.address, frame)
        for (const record of frame.records) assertSessionWireEvent(record.event)
        if (frame.assistantStream === undefined) {
          throw new RemoteError(
            'gateway/internal',
            'session assistant stream omitted its opted-in opening baseline',
            {},
          )
        }
        assistantRevision = frame.assistantStream.revision
        this.followAuthorization = authorization
        yield {
          type: 'opened',
          cursor: frame.cursor,
          page: {
            records: frame.records,
            hasMore: frame.hasMore,
            authority: authorization !== undefined,
            ...(authorization === undefined ? {} : { authorization, header: frame.header }),
            projections: frame.projections,
            assistantStream: frame.assistantStream,
          },
        }
        continue
      }
      if (frame.type === 'assistant-stream') {
        const expected = (assistantRevision ?? 0) + 1
        if (frame.frame.revision !== expected) {
          throw new RemoteStreamCarrierError(
            `session assistant stream skipped revision ${String(expected)}`,
          )
        }
        assistantRevision = frame.frame.revision
        yield { type: 'notification', notification: frame.frame }
        continue
      }
      assertSessionWireEvent(frame.event)
      yield { type: 'entry', entry: frame }
    }
  }

  /** @inheritdoc */
  protected override async readPage(
    request: ClientSessionPageRequest,
    throughSeq: number,
    signal: AbortSignal,
  ): Promise<SessionJournalPage> {
    const authorization = this.followAuthorization
    const result = await this.remote.session.page(
      { address: this.address, throughSeq, ...request, ...verifiedFields(authorization) },
      signal,
    )
    signal.throwIfAborted()
    if (authorization !== undefined && this.sessionOptions.history?.()?.authorization !== authorization) {
      throw new RemoteStreamCarrierError('session history authorization changed during page read')
    }
    if (!result.ok) throw result.error
    const { cursor, records, hasMore } = result.value
    for (const record of records) assertSessionWireEvent(record.event)
    if (authorization !== undefined) {
      if (cursor !== throughSeq) throw invalidHistory('page cursor differs from the requested log cut')
      const end = Math.min(throughSeq + 1, request.beforeSeq ?? throughSeq + 1)
      assertRange(records, hasMore, end)
    }
    return { records, hasMore, authority: false, ...(authorization === undefined ? {} : { authorization }) }
  }

  /** @inheritdoc */
  protected override repairRequest(
    request: ClientSessionPageRequest,
  ): ClientSessionPageRequest {
    return {
      ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      ...(request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
    }
  }
}

function verifiedFields(authorization: HistoryAuthorization | undefined): Pick<SessionPageRequest, 'verifiedHistoryWindow' | 'historyRouteEpoch'> {
  if (authorization === undefined) return {}
  const route = authorization.route
  return { verifiedHistoryWindow: true, ...(route === undefined ? {} : { historyRouteEpoch: route.routeEpoch }) }
}

function assertOpening(address: SessionAddress, frame: Extract<SessionFollowFrame, { type: 'snapshot' }>): void {
  const { header, cursor, projections, records, hasMore } = frame
  if (!Number.isSafeInteger(cursor) || cursor < -1 || Object.is(cursor, -0) || projections.asOfSeq !== cursor) {
    throw invalidHistory('opening cursor differs from the projection cut')
  }
  const sameAddress = address.kind === 'session'
    ? header.id === address.sessionId && header.origin !== 'subagent'
    : header.id === address.childSessionId && header.origin === 'subagent'
      && header.parentSession === address.parentSessionId
      && (address.mode === 'unknown' || projections.values.subagent?.mode === address.mode)
  if (!sameAddress) throw invalidHistory('opening header differs from the requested address')
  assertRange(records, hasMore, cursor + 1)
}

function assertRange(records: readonly SessionHistoryRecord[], hasMore: boolean, end: number): void {
  const start = records[0]?.event.seq ?? end
  if (start !== end - records.length || hasMore !== (start > 0)
    || records.some((entry, index) => entry.event.seq !== start + index)
    || (end > 0 && records.length === 0)) {
    throw invalidHistory('records do not cover the declared range')
  }
}

function invalidHistory(message: string): RemoteError<'gateway/internal'> {
  return new RemoteError('gateway/internal', `session history: ${message}`, {})
}
