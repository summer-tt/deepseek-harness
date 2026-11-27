/** Verified history through the assembled Gateway, Connection, and Session references. */
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { expect, vi } from 'vitest'
import type { SessionEventsPage, SessionFollowRequest } from '../src/types.ts'
import { FOLLOW, PAGE, followSnapshot } from './remote/session.client.ts'

const it = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-api-session-controller']) })
const A = SessionId('session-a')
const B = SessionId('session-b')
const SERVER = 'aabb0011'
const PARENT = SessionId(`zr~${SERVER}~session-parent`)
const CHILD = SessionId(`zr~${SERVER}~session-child`)
const OWNER = { ownerEpoch: 'owner-first', supportsHistoryWindowStart: true }
const ROUTE = { serverId: SERVER, routeEpoch: 'paired-first', available: true }

function record(seq: number, label = `row-${String(seq)}`) {
  return { type: 'event' as const, event: { type: 'turn/start', seq, time: seq, data: { turn: seq, label } } }
}

function page(first: number, last: number): SessionEventsPage {
  return { cursor: last, records: Array.from({ length: last - first + 1 }, (_, index) => record(first + index)), hasMore: first > 0 }
}

async function emit(mock: RemoteMock, event: string, value: unknown): Promise<void> {
  mock.streams.push('$events', { type: 'emit', event, args: [value] })
  await mock.streams.drained('$events')
}

function catalog(mock: RemoteMock, ...ids: ReturnType<typeof SessionId>[]): void {
  mock.remote.session.list.mockResolvedValue(ok({ items: ids.map(sessionId => ({
    sessionId, agentAvailable: true, blank: false, running: false, updatedAt: 1,
  })) }))
}

function followRequest(value: unknown): SessionFollowRequest { return value as SessionFollowRequest }

it('reuses the complete window after A → B → A with zero notifications and excludes any unconsumed page', async ({ mock, start }) => {
  catalog(mock, A, B)
  const requests: SessionFollowRequest[] = []
  const late = Promise.withResolvers<undefined>()
  let hold = false
  let confirmedStart = 2
  mock.stream(FOLLOW, async ([value], stream) => {
    const request = followRequest(value)
    requests.push(request)
    if (hold) await late.promise
    stream.push(followSnapshot(page(confirmedStart, 4), request))
  })
  mock.remote.session.page.mockImplementation(async request => ok({ ...page(0, 1), cursor: request.throughSeq ?? 4 }))
  const client = await start()
  const sessions = client.ctx.sessions
  await sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  using first = sessions.retain(A, { source: 'gateway' })
  const firstSession = first.binding.session
  await first.ready
  const oldPosition = firstSession.readingPosition?.('chat')
  expect(requests[0]).toMatchObject({ verifiedHistoryWindow: true })
  expect(requests[0]?.historyWindowStart).toBeUndefined()
  await firstSession.loadOlder({ deferConsumption: true })
  expect(mock.remote.session.page).toHaveBeenCalledWith(expect.objectContaining({ verifiedHistoryWindow: true, beforeSeq: 2 }))
  oldPosition?.write({ seq: 3, offset: 1 })
  const detached = vi.fn()
  const unregister = firstSession.registerReadingPositionFlush?.(detached)
  unregister?.()
  const flush = vi.fn(() => { oldPosition?.write({ seq: 3, offset: 11 }) })
  firstSession.registerReadingPositionFlush?.(flush)
  first.release()
  expect(flush).toHaveBeenCalledOnce()
  expect(detached).not.toHaveBeenCalled()
  using middle = sessions.retain(B, { source: 'gateway' })
  await middle.ready
  middle.release()

  hold = true
  using abandoned = sessions.retain(A, { source: 'gateway' })
  expect(abandoned.binding.session.getSnapshot()).toMatchObject({ openState: 'loading', historyAvailability: 'cached' })
  expect(abandoned.binding.eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([2, 3, 4])
  abandoned.release()
  hold = false
  late.resolve(undefined)

  using returning = sessions.retain(A, { source: 'gateway' })
  const { eventSource, session } = returning.binding
  const cached = eventSource.getSnapshot()
  const listener = vi.fn()
  const off = eventSource.subscribe(listener)
  try {
    // A release callback from an earlier binding cannot update the replacement's position.
    oldPosition?.write({ seq: 99 })
    expect(session.readingPosition?.('chat')?.read()).toEqual({ seq: 3, offset: 11 })
    await returning.ready
    expect(requests.at(-1)).toMatchObject({ verifiedHistoryWindow: true, historyWindowStart: 2 })
    expect(eventSource.getSnapshot()).toBe(cached)
    expect(listener).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toMatchObject({ openState: 'open', historyAvailability: 'confirmed' })
    await session.loadOlder()
    expect(eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([0, 1, 2, 3, 4])
  } finally {
    off()
  }
  returning.release()
  confirmedStart = 0
  using paged = sessions.retain(A, { source: 'gateway' })
  expect(paged.binding.eventSource.getSnapshot().entries).toHaveLength(5)
  await paged.ready
  expect(requests.at(-1)?.historyWindowStart).toBe(0)
})

it('sends offline suffix as history, keeps live appends separate, and rewinds the same physical journal with fresh projection watermarks', async ({ mock, start }) => {
  catalog(mock, A)
  let opening = page(0, 1)
  let title = 'before'
  mock.stream(FOLLOW, ([request], stream) => {
    stream.push(followSnapshot({ ...opening, projections: { asOfSeq: opening.cursor, values: { title } } }, followRequest(request)))
  })
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  using first = ctx.sessions.retain(A, { source: 'gateway' })
  await first.ready
  const prefix = first.binding.eventSource.getSnapshot().entries[0]
  first.release()
  opening = page(0, 2)
  using second = ctx.sessions.retain(A, { source: 'gateway' })
  const { session, eventSource } = second.binding
  await second.ready
  expect(eventSource.getSnapshot().change.kind).toBe('history-append')
  expect(eventSource.getSnapshot().entries[0]).toBe(prefix)
  mock.streams.push(FOLLOW, record(3))
  await vi.waitFor(() => { expect(eventSource.getSnapshot().change.kind).toBe('append') })
  mock.streams.push('session/control', { type: 'projection', sessionId: A, seq: 99, changes: [{ key: 'title', val: 'stale watermark' }] })
  await vi.waitFor(() => { expect(session.projections.faceOf('title').getSnapshot()).toBe('stale watermark') })

  opening = { ...page(0, 1), records: [record(0), record(1, 'different branch')] }
  title = 'after rewind'
  mock.streams.fail(FOLLOW, new RemoteStreamCarrierError('reconnect changed journal'))
  await vi.waitFor(() => {
    expect(session.projections.faceOf('title').getSnapshot()).toBe('after rewind')
    expect(eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([0, 1])
  })
  expect(eventSource.getSnapshot().change.kind).toBe('replace')
  expect(eventSource.getSnapshot().entries[0]).toBe(prefix)
  await mock.streams.opened('session/control', 2)
  mock.streams.push(FOLLOW, record(2))
  await vi.waitFor(() => { expect(eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([0, 1, 2]) })

  opening = page(0, -1)
  title = 'empty journal'
  mock.streams.fail(FOLLOW, new RemoteStreamCarrierError('reconnect to empty journal'))
  await vi.waitFor(() => {
    expect(eventSource.getSnapshot().entries).toEqual([])
    expect(session.projections.faceOf('title').getSnapshot()).toBe('empty journal')
  })
})

it('rejects mismatched authority before displaying the returned records and retries an ordinary open after a route-change failure', async ({ mock, start }) => {
  catalog(mock, PARENT)
  const requests: SessionFollowRequest[] = []
  let answer: 'valid' | 'wrong-header' | 'route-change' = 'valid'
  mock.stream(FOLLOW, ([value], stream) => {
    const request = followRequest(value)
    requests.push(request)
    if (answer === 'route-change' && request.verifiedHistoryWindow === true) {
      const error = new RemoteError('gateway/internal', 'route changed', {})
      stream.fail(Object.assign(error, { code: 'history-route-changed' }))
      return
    }
    const snapshot = followSnapshot(page(0, 1), request)
    stream.push(answer === 'wrong-header' ? { ...snapshot, header: { ...snapshot.header, id: B } } : snapshot)
  })
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  await emit(mock, 'api-session/history-route', ROUTE)
  using first = ctx.sessions.retain(PARENT, { source: 'gateway' })
  await first.ready
  first.release()
  answer = 'wrong-header'
  using wrong = ctx.sessions.retain(PARENT, { source: 'gateway' })
  await wrong.ready
  expect(wrong.binding.session.getSnapshot()).toMatchObject({ openState: 'error', openError: { code: 'gateway/internal' } })
  expect(wrong.binding.eventSource.getSnapshot().entries).toHaveLength(2)
  wrong.release()
  answer = 'route-change'
  using recovering = ctx.sessions.retain(PARENT, { source: 'gateway' })
  await recovering.ready
  await vi.waitFor(() => { expect(recovering.binding.session.getSnapshot()).toMatchObject({ openState: 'open' }) })
  expect(requests.at(-2)).toMatchObject({ historyRouteEpoch: ROUTE.routeEpoch, historyWindowStart: 0 })
  expect(requests.at(-1)?.verifiedHistoryWindow).toBeUndefined()
  expect(recovering.binding.session.readingPosition?.('chat')?.read()).toBeUndefined()
})

it('invalidates a family on unshare and rejects stale route epochs without disturbing the new pairing', async ({ mock, start }) => {
  catalog(mock, PARENT, CHILD)
  const requests: SessionFollowRequest[] = []
  mock.stream(FOLLOW, ([value], stream) => {
    const request = followRequest(value)
    requests.push(request)
    stream.push(followSnapshot(page(0, 1), request))
  })
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  const address = { childSessionId: CHILD, parentSessionId: PARENT, mode: 'unknown' as const }
  using legacy = ctx.sessions.retain(address, { source: 'gateway' })
  await legacy.ready
  expect(requests.at(-1)?.verifiedHistoryWindow).toBeUndefined()
  legacy.release()
  await emit(mock, 'api-session/history-route', ROUTE)
  using parent = ctx.sessions.retain(PARENT, { source: 'gateway' })
  using child = ctx.sessions.retain(address, { source: 'gateway' })
  await Promise.all([parent.ready, child.ready])
  const revokedPosition = parent.binding.session.readingPosition?.('chat')
  revokedPosition?.write({ seq: 0 })
  child.binding.session.readingPosition?.('chat')?.write({ seq: 1 })
  child.release()
  await emit(mock, 'api-session/history-invalidated', { ...ROUTE, sessionId: PARENT })
  expect(parent.binding.session.getSnapshot()).toMatchObject({ openState: 'error', historyAvailability: 'unavailable' })
  expect(parent.binding.eventSource.getSnapshot().entries).toEqual([])
  revokedPosition?.write({ seq: 99 })
  expect(revokedPosition?.read()).toBeUndefined()
  expect(parent.binding.session.readingPosition?.('chat')).toBeUndefined()
  using childAgain = ctx.sessions.retain(address, { source: 'gateway' })
  expect(childAgain.binding.session.readingPosition?.('chat')?.read()).toBeUndefined()
  expect(childAgain.binding.session.getSnapshot().historyAvailability).toBe('unavailable')
  await childAgain.ready
  childAgain.release()

  await emit(mock, 'api-session/history-route', { ...ROUTE, routeEpoch: 'paired-second' })
  using repaired = ctx.sessions.retain(address, { source: 'gateway' })
  expect(repaired.binding.session.getSnapshot().historyAvailability).toBe('unavailable')
  await repaired.ready
  await emit(mock, 'api-session/history-invalidated', { ...ROUTE, sessionId: PARENT })
  expect(repaired.binding.session.getSnapshot()).toMatchObject({ openState: 'open', historyAvailability: 'confirmed' })
  expect(requests.at(-1)).toMatchObject({ historyRouteEpoch: 'paired-second' })
})

it('clears active history and cached positions on an addressed permission refusal', async ({ mock, start }) => {
  catalog(mock, A)
  mock.stream(FOLLOW, ([request], stream) => { stream.push(followSnapshot(page(2, 4), followRequest(request))) })
  mock.remote.session.page.mockResolvedValue({ ok: false, error: new RemoteError('remote-access/denied', 'refused', { action: PAGE, reason: 'no-allow' }) })
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  using first = ctx.sessions.retain(A, { source: 'gateway' })
  await first.ready
  first.binding.session.readingPosition?.('chat')?.write({ seq: 4 })
  await first.binding.session.loadOlder()
  expect(first.binding.session.getSnapshot()).toMatchObject({ openState: 'error', openError: { code: 'remote-access/denied' }, historyAvailability: 'unavailable' })
  expect(first.binding.eventSource.getSnapshot().entries).toEqual([])
  first.release()
  using next = ctx.sessions.retain(A, { source: 'gateway' })
  expect(next.binding.session.readingPosition?.('chat')?.read()).toBeUndefined()
  expect(next.binding.session.getSnapshot().historyAvailability).toBe('unavailable')
  await next.ready
})

for (const rejectionScope of ['known generation', 'during outage']) {
  it(`fences HTTP refusal across a frozen and a newer owner generation (${rejectionScope})`, async ({ mock, start }) => {
    catalog(mock, A)
    const reconnectReady = Promise.withResolvers<undefined>()
    let opens = 0
    mock.stream('$events', async (_args, stream) => {
      opens += 1
      if (opens === 2) await reconnectReady.promise
      stream.push({ type: 'ready', clientId: `history-peer-${String(opens)}`, host: { home: '/home/mock' } })
    })
    mock.stream(FOLLOW, ([request], stream) => { stream.push(followSnapshot(page(0, 1), followRequest(request))) })
    const client = await start()
    const { ctx, connection } = client
    await ctx.sessions.refresh()
    await emit(mock, 'api-session/history-owner', OWNER)
    const old = connection.generation.getSnapshot()?.id
    using first = ctx.sessions.retain(A, { source: 'gateway' })
    await first.ready
    first.binding.session.readingPosition?.('chat')?.write({ seq: 1 })
    first.release()
    connection.reconnect()
    await vi.waitFor(() => { expect(connection.generation.getSnapshot()).toBeUndefined() })
    using frozen = ctx.sessions.retain(A, { source: 'gateway' })
    expect(frozen.binding.session.readingPosition?.('chat')?.read()).toBeUndefined()
    expect(frozen.binding.session.getSnapshot().historyAvailability).toBe('unavailable')
    frozen.release()
    const rejectedGeneration = rejectionScope === 'known generation' ? old : undefined
    await ctx.parallel('connection/authentication-rejected', { generation: rejectedGeneration, status: 401 })
    reconnectReady.resolve(undefined)
    await vi.waitFor(() => {
      expect(connection.generation.getSnapshot()?.id).not.toBe(old)
      expect(connection.generation.getSnapshot()).toBeDefined()
    })
    await emit(mock, 'api-session/history-owner', OWNER)
    using second = ctx.sessions.retain(A, { source: 'gateway' })
    expect(second.binding.session.readingPosition?.('chat')?.read()).toBeUndefined()
    expect(second.binding.session.getSnapshot().historyAvailability).toBe('unavailable')
    await second.ready
    second.binding.session.readingPosition?.('chat')?.write({ seq: 0 })
    second.release()
    await ctx.parallel('connection/authentication-rejected', { generation: rejectedGeneration, status: 403 })
    using latest = ctx.sessions.retain(A, { source: 'gateway' })
    expect(latest.binding.session.readingPosition?.('chat')?.read()).toEqual({ seq: 0 })
    expect(latest.binding.session.getSnapshot().historyAvailability).toBe('cached')
    await latest.ready
  })
}

it('does not publish a late page after relay generation replacement', async ({ mock, start }) => {
  catalog(mock, PARENT)
  mock.stream(FOLLOW, ([request], stream) => { stream.push(followSnapshot(page(2, 4), followRequest(request))) })
  const late = Promise.withResolvers<RemoteResult<SessionEventsPage>>()
  mock.remote.session.page.mockReturnValueOnce(late.promise)
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  await emit(mock, 'api-session/history-route', ROUTE)
  using ref = ctx.sessions.retain(PARENT, { source: 'gateway' })
  await ref.ready
  const { session, eventSource } = ref.binding
  const position = session.readingPosition?.('chat')
  const epoch = session.getSnapshot().historyEpoch
  position?.write({ seq: 3 })
  const loading = session.loadOlder({ deferConsumption: true })
  await vi.waitFor(() => { expect(mock.log.requests(PAGE)).toHaveLength(1) })
  await emit(mock, 'api-session/history-route', { ...ROUTE, routeEpoch: 'paired-second' })
  await vi.waitFor(() => { expect(mock.log.requests(FOLLOW)).toHaveLength(2) })
  await mock.streams.drained(FOLLOW)
  late.resolve(ok({ ...page(0, 1), cursor: 4 }))
  await loading
  const replacementPosition = session.readingPosition?.('chat')
  expect(session.getSnapshot().historyEpoch).not.toBe(epoch)
  expect(replacementPosition?.read()).toBeUndefined()
  position?.write({ seq: 99 })
  expect(replacementPosition?.read()).toBeUndefined()
  expect(session.consumeOlder()).toBe(false)
  expect(eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([2, 3, 4])
  mock.remote.session.page.mockResolvedValueOnce(ok({ ...page(0, 1), cursor: 4 }))
  await session.loadOlder()
  expect(eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([0, 1, 2, 3, 4])
})


it('resets only the replaced relay projection sequence space when its new opening rewinds', async ({ mock, start }) => {
  catalog(mock, A, PARENT, CHILD)
  let opening = page(0, 4)
  mock.stream(FOLLOW, ([value], stream) => {
    const request = followRequest(value)
    const title = opening.cursor === 4 ? 'previous pairing' : 'replacement pairing'
    stream.push(followSnapshot({ ...opening, projections: { asOfSeq: opening.cursor, values: { title } } }, request))
  })
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  await emit(mock, 'api-session/history-route', ROUTE)
  using remote = ctx.sessions.retain(PARENT, { source: 'gateway' })
  await remote.ready
  const { session, eventSource } = remote.binding
  for (const sessionId of [A, PARENT, CHILD]) {
    mock.streams.push('session/control', { type: 'projection', sessionId, seq: 99, changes: [{ key: 'title', val: `cached-${sessionId}` }] })
  }
  await vi.waitFor(() => {
    expect(ctx.sessions.list.getSnapshot().projectionsBySession[CHILD]?.values.title).toBe(`cached-${CHILD}`)
  })
  const oldEpoch = session.getSnapshot().historyEpoch
  opening = page(0, 1)
  await emit(mock, 'api-session/history-route', { ...ROUTE, routeEpoch: 'pairing-replaced' })
  await vi.waitFor(() => {
    expect(session.getSnapshot()).toMatchObject({ openState: 'open', historyAvailability: 'confirmed' })
    expect(session.getSnapshot().historyEpoch).not.toBe(oldEpoch)
    expect(eventSource.getSnapshot().entries).toHaveLength(2)
    expect(session.projections.faceOf('title').getSnapshot()).toBe('replacement pairing')
    expect(ctx.sessions.list.getSnapshot().projectionsBySession[CHILD]?.values.title).toBeUndefined()
    expect(ctx.sessions.list.getSnapshot().projectionsBySession[A]?.values.title).toBe(`cached-${A}`)
  })
})


it('stops active verified relay history on event loss and waits for a renewed route', async ({ mock, start }) => {
  catalog(mock, PARENT)
  const requests: SessionFollowRequest[] = []
  mock.stream(FOLLOW, ([value], stream) => {
    const request = followRequest(value)
    requests.push(request)
    stream.push(followSnapshot(page(0, 1), request))
  })
  const client = await start()
  const { ctx, connection } = client
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  await emit(mock, 'api-session/history-route', ROUTE)
  using ref = ctx.sessions.retain(PARENT, { source: 'gateway' })
  await ref.ready
  const { session, eventSource } = ref.binding
  const generation = connection.generation.getSnapshot()?.id
  if (generation === undefined) throw new Error('expected a connected browser')
  await ctx.parallel('connection/history-authorization-ended', { generation })
  expect(eventSource.getSnapshot().entries).toEqual([])
  expect(session.getSnapshot()).toMatchObject({ openState: 'loading', historyAvailability: 'unavailable' })
  connection.reconnect()
  await mock.streams.opened('$events', 2)
  await vi.waitFor(() => { expect(connection.generation.getSnapshot()?.id).toBe(generation + 1) })
  await emit(mock, 'api-session/history-owner', OWNER)
  expect(requests).toHaveLength(1)
  await emit(mock, 'api-session/history-route', { ...ROUTE, routeEpoch: 'renewed-after-loss' })
  await vi.waitFor(() => {
    expect(requests.at(-1)).toMatchObject({ verifiedHistoryWindow: true, historyRouteEpoch: 'renewed-after-loss' })
    expect(session.getSnapshot()).toMatchObject({ openState: 'open', historyAvailability: 'confirmed' })
  })
  expect(requests).toHaveLength(2)
})

it('uses ordinary follow after an authenticated reconnect gives no verified route', async ({ mock, start }) => {
  catalog(mock, PARENT)
  const requests: SessionFollowRequest[] = []
  mock.stream(FOLLOW, ([value], stream) => {
    const request = followRequest(value)
    requests.push(request)
    stream.push(followSnapshot(page(0, 1), request))
  })
  const client = await start()
  const { ctx, connection } = client
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  await emit(mock, 'api-session/history-route', ROUTE)
  using ref = ctx.sessions.retain(PARENT, { source: 'gateway' })
  await ref.ready
  const { session, eventSource } = ref.binding
  const generation = connection.generation.getSnapshot()?.id
  if (generation === undefined) throw new Error('expected a connected browser')
  await ctx.parallel('connection/history-authorization-ended', { generation })
  expect(eventSource.getSnapshot().entries).toEqual([])
  expect(session.getSnapshot()).toMatchObject({ openState: 'loading', historyAvailability: 'unavailable' })
  connection.reconnect()
  await mock.streams.opened('$events', 2)
  await vi.waitFor(() => { expect(connection.generation.getSnapshot()?.id).toBe(generation + 1) })
  await emit(mock, 'api-session/history-owner', OWNER)
  expect(requests).toHaveLength(1)
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2)
    expect(session.getSnapshot()).toMatchObject({ openState: 'open', historyAvailability: 'confirmed' })
  }, { timeout: 2_000 })
  expect(requests.at(-1)?.verifiedHistoryWindow).toBeUndefined()
  expect(requests.at(-1)?.historyWindowStart).toBeUndefined()
})


it('discards a deferred older page as soon as Assistant requests a fresh opening', async ({ mock, start }) => {
  catalog(mock, A)
  const opening = Promise.withResolvers<undefined>()
  let follows = 0
  mock.stream(FOLLOW, async ([value], stream) => {
    follows += 1
    if (follows === 2) await opening.promise
    stream.push(followSnapshot(page(2, 4), followRequest(value)))
  })
  mock.remote.session.page.mockResolvedValue(ok({ ...page(0, 1), cursor: 4 }))
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  using ref = ctx.sessions.retain(A, { source: 'gateway' })
  await ref.ready
  const { session, eventSource } = ref.binding
  await session.loadOlder({ deferConsumption: true })
  expect(session.getSnapshot().historyLoadStatus).toBe('pendingConsumption')

  try {
    mock.streams.push(FOLLOW, { type: 'assistant-stream', frame: {
      type: 'start', attemptId: 'attempt-one', revision: 1, startedAfterSeq: 4, turn: 1, step: 1,
    } })
    mock.streams.push(FOLLOW, { type: 'assistant-stream', frame: {
      type: 'start', attemptId: 'attempt-two', revision: 2, startedAfterSeq: 4, turn: 1, step: 1,
    } })
    await vi.waitFor(() => { expect(follows).toBe(2) })
    expect(session.getSnapshot()).toMatchObject({ historyAvailability: 'cached', historyLoadStatus: 'idle' })
    expect(session.consumeOlder()).toBe(false)
    expect(eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([2, 3, 4])
  } finally {
    opening.resolve(undefined)
  }
  await vi.waitFor(() => { expect(session.getSnapshot().historyAvailability).toBe('confirmed') })
  await session.loadOlder()
  expect(eventSource.getSnapshot().entries.map(item => item.event.seq)).toEqual([0, 1, 2, 3, 4])
})


it('resets the Child projection and opening when its full parent address changes', async ({ mock, start }) => {
  const replacementParent = SessionId(`zr~${SERVER}~session-replacement-parent`)
  const address = { childSessionId: CHILD, parentSessionId: PARENT, mode: 'unknown' as const }
  catalog(mock, PARENT, CHILD, replacementParent)
  mock.stream(FOLLOW, ([value], stream) => {
    const request = followRequest(value)
    const firstAddress = request.address.kind === 'subagent' && request.address.parentSessionId === PARENT
    const opening = firstAddress ? page(0, 4) : page(0, 1)
    const title = firstAddress ? 'old parent' : 'new parent'
    stream.push(followSnapshot({ ...opening, projections: { asOfSeq: opening.cursor, values: { title } } }, request))
  })
  const { ctx } = await start()
  await ctx.sessions.refresh()
  await emit(mock, 'api-session/history-owner', OWNER)
  await emit(mock, 'api-session/history-route', ROUTE)
  using first = ctx.sessions.retain(address, { source: 'gateway' })
  await first.ready
  first.binding.session.readingPosition?.('chat')?.write({ seq: 4 })
  mock.streams.push('session/control', { type: 'projection', sessionId: CHILD, seq: 99, changes: [{ key: 'title', val: 'old parent watermark' }] })
  await vi.waitFor(() => {
    expect(first.binding.session.projections.faceOf('title').getSnapshot()).toBe('old parent watermark')
  })
  first.release()
  using next = ctx.sessions.retain({ ...address, parentSessionId: replacementParent }, { source: 'gateway' })
  expect(next.binding.eventSource.getSnapshot().entries).toEqual([])
  await next.ready
  await vi.waitFor(() => { expect(next.binding.session.projections.faceOf('title').getSnapshot()).toBe('new parent') })
  expect(next.binding.session.readingPosition?.('chat')?.read()).toBeUndefined()
  expect(next.binding.eventSource.getSnapshot().entries).toHaveLength(2)
})
