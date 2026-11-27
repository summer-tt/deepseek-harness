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
  cache.retain(huge, grant, windowOf(huge.sessionId, 'short', 1_501))
  expect(cache.read(huge, grant)).toBeUndefined()
  cache.retain(huge, grant, windowOf(huge.sessionId, 'short', 1_500))
  expect(cache.read(huge, grant)?.entries).toHaveLength(1_500)
})

it('scopes local reuse to the confirmed owner and freezes reads despite a matching retained grant', () => {
  const { cache, grant } = authorized()
  const target = address(0)
  cache.retain(target, grant, windowOf(target.sessionId, 'local'))
  cache.end(1, false)
  expect(cache.authorization(target)).toBeUndefined()
  expect(cache.read(target, grant)).toBeUndefined()
  cache.connect(2)
  cache.authorize(OWNER)
  const returned = cache.authorization(target)
  if (returned === undefined) throw new Error('expected a replacement grant')
  expect(returned).not.toBe(grant)
  expect(cache.read(target, returned)).toBeDefined()
  cache.retain(target, grant, undefined)
  expect(cache.read(target, returned)).toBeDefined()
  cache.connect(3)
  cache.authorize(alternate)
  cache.connect(4)
  cache.authorize(OWNER)
  const newGrant = cache.authorization(target)
  if (newGrant === undefined) throw new Error('expected a new owner grant')
  expect(cache.read(target, newGrant)).toBeUndefined()
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
  cache.invalidate(candidate => historyDependsOn(candidate, parentSessionId))
  expect(cache.read(one, grant)).toBeUndefined()
})
