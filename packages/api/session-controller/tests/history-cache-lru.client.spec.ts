/** Capacity and authorization properties of the Manager's inactive history storage. */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it } from 'vitest'
import type { SessionAddress, SessionHistoryOwner } from '../src/types.ts'
import {
  historyDependsOn, SessionHistoryCache,
  type DurableHistoryWindow, type HistoryAuthorization,
} from '../src/client/sessions/history-cache.ts'
import { historyEntries } from '../src/client/sessions/history-records.ts'

const OWNER = { ownerEpoch: 'peer-one' as SessionHistoryOwner['ownerEpoch'], supportsHistoryWindowStart: true } as const
const alternate = { ...OWNER, ownerEpoch: 'peer-two' as SessionHistoryOwner['ownerEpoch'] }

function address(index: number): Extract<SessionAddress, { kind: 'session' }> {
  return { kind: 'session', sessionId: SessionId(`session-${String(index)}`) }
}

function windowOf(id: SessionId, text: string, count = 1): DurableHistoryWindow {
  return {
    header: { id, version: 2, createdAt: 0, isSeeded: false }, hasMore: false,
    entries: historyEntries(Array.from({ length: count }, (_, seq) => ({
      type: 'event', event: { type: 'turn/start', seq, time: seq, data: { turn: seq, text } },
    }))),
  }
}

function authorized(): { cache: SessionHistoryCache; grant: HistoryAuthorization } {
  const cache = new SessionHistoryCache()
  cache.connect(1)
  cache.authorize(OWNER)
  const grant = cache.authorization(address(0))
  if (grant === undefined) throw new Error('expected owner authorization')
  return { cache, grant }
}

it('retains up to 12 entries and refreshes recency on reads, including positions-only entries', () => {
  const { cache, grant } = authorized()
  for (let index = 0; index < 12; index += 1) {
    const target = address(index)
    cache.retain(target, grant, windowOf(target.sessionId, 'short'))
  }
  expect(cache.read(address(0), grant)).toBeDefined()
  cache.writePosition(address(12), 'chat', { seq: 3 })
  expect(cache.read(address(1), grant) === undefined).toBe(true)
  expect(cache.read(address(0), grant)).toBeDefined()
  expect(cache.readPosition(address(12), 'chat')).toEqual({ seq: 3 })
  cache.writePosition(address(12), 'chat', undefined)
  expect(cache.readPosition(address(12), 'chat')).toBeUndefined()
})

it('evicts by the combined byte budget and declines oversized records and windows', () => {
  const { cache, grant } = authorized()
  const text = 'a'.repeat(855_000)
  for (let index = 0; index < 6; index += 1) {
    const target = address(index)
    cache.retain(target, grant, windowOf(target.sessionId, text))
  }
  expect(cache.read(address(0), grant) === undefined).toBe(true)
  expect(cache.read(address(1), grant) === undefined).toBe(true)
  expect(cache.read(address(2), grant)).toBeDefined()
  expect(cache.read(address(5), grant)).toBeDefined()
  const huge = address(7)
  cache.writePosition(huge, 'chat', { seq: 1 })
  const oversized = windowOf(huge.sessionId, 'z'.repeat(2 * 1024 * 1024))
  cache.retain(huge, grant, oversized)
  expect(cache.read(huge, grant)).toBeUndefined()
  expect(cache.readPosition(huge, 'chat')).toEqual({ seq: 1 })
})

it('keeps a whole admitted window by identity, including partial Turns and empty logs', () => {
  const { cache, grant } = authorized()
  const target = address(0)
  const source = windowOf(target.sessionId, '', 1_500)
  const partial = { ...source, entries: historyEntries(source.entries.map(({ event }) => ({
    type: 'event', event: { seq: event.seq, time: event.time, type: 'turn/end', data: { turn: event.seq } },
  }))) }
  cache.retain(target, grant, partial)
  expect(cache.read(target, grant)).toBe(partial)
  cache.retain(target, grant, partial, true)
  expect(cache.read(target, grant)).toBeUndefined()
  const empty = windowOf(target.sessionId, '', 0)
  cache.retain(target, grant, empty)
  expect(cache.read(target, grant)).toBe(empty)
})

it('skips an oversized prefix and retains the oldest fitting Turn boundary with original records', () => {
  const { cache, grant } = authorized()
  const target = address(0)
  const source = windowOf(target.sessionId, '', 4)
  const payloads = ['a'.repeat(1_100_000), 'b'.repeat(700_000), 'c'.repeat(400_000), 'end']
  const entries = historyEntries(source.entries.map(({ event }, index) => ({
    type: 'event', event: {
      seq: event.seq, time: event.time, type: index === 1 || index === 3 ? 'turn/end' : 'turn/start',
      data: { text: payloads[index]! },
    },
  })))
  cache.retain(target, grant, { ...source, entries })
  expect(cache.read(target, grant)).toMatchObject({ hasMore: true, entries: entries.slice(2) })
  expect(cache.read(target, grant)?.entries[0]).toBe(entries[2])
  expect(cache.read(target, grant)?.entries[1]).toBe(entries[3])
  const oversizedHead = historyEntries([
    { type: 'event', event: { type: 'turn/start', seq: 0, time: 0, data: { text: 'a'.repeat(1_100_000) } } },
  ])
  const afterHugeHead = [...oversizedHead, ...source.entries.slice(1)]
  cache.retain(target, grant, { ...source, entries: afterHugeHead })
  expect(cache.read(target, grant)?.entries[0]).toBe(afterHugeHead[1])
})

it('measures only the last 1,500 direct records and retains a suffix from a Turn boundary', () => {
  const { cache, grant } = authorized()
  const target = address(0)
  const window = windowOf(target.sessionId, 'short', 1_502)
  const entries = [...window.entries]
  for (const index of [0, 1]) {
    Object.defineProperty(entries, index, { get: () => { throw new Error('discarded prefix was read') } })
  }
  cache.retain(target, grant, { ...window, entries })
  const retained = cache.read(target, grant)
  expect(retained?.hasMore).toBe(true)
  expect(retained?.entries).toHaveLength(1_500)
  expect(retained?.entries[0]).toBe(window.entries[2])
  expect(retained?.entries.at(-1)).toBe(window.entries.at(-1))
})

it('retains only positions when the final record or the complete tail Turn exceeds the budget', () => {
  const { cache, grant } = authorized()
  const target = address(0)
  cache.writePosition(target, 'chat', { seq: 1 })
  const source = windowOf(target.sessionId, '', 2)
  for (const [head, tail] of [[0, 1_100_000], [600_000, 600_000]] as const) {
    const entries = historyEntries(source.entries.map(({ event }, i) => ({
      type: 'event', event: { ...event, type: i === 0 ? 'turn/start' : 'turn/end', data: { text: 'a'.repeat(i === 0 ? head : tail) } },
    })))
    cache.retain(target, grant, { ...source, entries })
    expect(cache.read(target, grant)).toBeUndefined()
    expect(cache.readPosition(target, 'chat')).toEqual({ seq: 1 })
  }
})

it('keeps an exact-budget window through position writes and counts only actual positions globally', () => {
  const { cache, grant } = authorized()
  const target = address(0)
  // The empty text fixture, cache key, and position reserve account for 5,460 bytes.
  const text = 'a'.repeat((2 * 1024 * 1024 - 5_460) / 2)
  const exact = windowOf(target.sessionId, text)
  cache.retain(target, grant, exact)
  const position = 'p'.repeat(2_002)
  cache.writePosition(target, 'chat', position)
  expect(cache.readPosition(target, 'chat')).toBe(position)
  expect(cache.read(target, grant)).toBe(exact)
  cache.retain(target, grant, windowOf(target.sessionId, `${text}a`))
  expect(cache.read(target, grant)).toBeUndefined()
  expect(cache.readPosition(target, 'chat')).toBe(position)

  const windows = Array.from({ length: 5 }, (_, i) => windowOf(address(i).sessionId, 'a'.repeat(838_000)))
  cache.writePosition(target, 'chat', undefined)
  for (const [i, window] of windows.entries()) cache.retain(address(i), grant, window)
  expect(cache.read(target, grant)).toBe(windows[0])
  cache.writePosition(address(4), 'chat', position)
  expect(cache.read(address(1), grant)).toBeUndefined()
  expect(cache.read(address(4), grant)).toBe(windows[4])
})

it('scopes local reuse to the confirmed owner and freezes reads despite a matching retained grant', () => {
  const { cache, grant } = authorized()
  const target = address(0)
  cache.retain(target, grant, windowOf(target.sessionId, 'local'))
  cache.writePosition(target, 'chat', { seq: 0 })
  cache.end(1, false)
  expect(cache.authorization(target)).toBeUndefined()
  expect(cache.read(target, grant)).toBeUndefined()
  cache.connect(2)
  cache.authorize(OWNER)
  const returned = cache.authorization(target)
  if (returned === undefined) throw new Error('expected a replacement grant')
  expect(returned).not.toBe(grant)
  expect(cache.read(target, returned)).toBeDefined()
  expect(cache.readPosition(target, 'chat')).toEqual({ seq: 0 })
  cache.retain(target, grant, undefined)
  expect(cache.read(target, returned)).toBeDefined()
  cache.connect(3)
  cache.authorize(alternate)
  cache.connect(4)
  cache.authorize(OWNER)
  const newGrant = cache.authorization(target)
  if (newGrant === undefined) throw new Error('expected a new owner grant')
  expect(cache.read(target, newGrant)).toBeUndefined()
  expect(cache.readPosition(target, 'chat')).toBeUndefined()
})

it('isolates the complete parent/child address and rejects ambiguous relay routes', () => {
  const { cache } = authorized()
  const parentSessionId = SessionId('zr~aabb0011~parent')
  const childSessionId = SessionId('zr~aabb0011~child')
  const one = { kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' } as const
  const wrong = { ...one, parentSessionId: SessionId('zr~bbaa1100~parent') }
  cache.updateRoute({ serverId: 'aabb0011', routeEpoch: 'first', available: true })
  expect(cache.authorization(wrong)).toBeUndefined()
  expect(cache.authorization({ kind: 'session', sessionId: SessionId('zr~malformed') })).toBeUndefined()
  const grant = cache.authorization(one)
  if (grant === undefined) throw new Error('expected route authorization')
  cache.retain(one, grant, windowOf(childSessionId, 'remote'))
  expect(cache.read({ ...one, mode: 'unknown' }, grant)).toBeUndefined()
  expect(cache.read({ ...one, parentSessionId: SessionId('zr~aabb0011~different') }, grant)).toBeUndefined()
  expect(cache.read(one, grant)).toBeDefined()
  cache.writePosition(one, 'chat', { seq: 0 })
  cache.invalidate(candidate => historyDependsOn(candidate, parentSessionId))
  expect(cache.read(one, grant)).toBeUndefined()
  expect(cache.readPosition(one, 'chat')).toBeUndefined()
  cache.retain(one, grant, windowOf(childSessionId, 'obsolete'))
  cache.writePosition(one, 'chat', { seq: 0 })
  cache.updateRoute({ serverId: 'aabb0011', routeEpoch: 'second', available: true })
  const replacement = cache.authorization(one)
  if (replacement === undefined) throw new Error('expected replacement route authorization')
  const current = windowOf(childSessionId, 'replacement')
  cache.retain(one, replacement, current)
  cache.retain(one, grant, windowOf(childSessionId, 'obsolete'), true)
  expect(cache.read(one, grant)).toBeUndefined()
  expect(cache.read(one, replacement)).toBe(current)
  expect(cache.readPosition(one, 'chat')).toBeUndefined()
})
