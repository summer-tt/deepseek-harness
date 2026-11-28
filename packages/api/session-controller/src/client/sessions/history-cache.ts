/** Page-local retention for authorized durable windows and reading positions. */
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionAddress, SessionHistoryOwner, SessionHistoryRoute, SessionWireHeader } from '../../types.ts'
import type { SessionLiveEventEntry } from '../contract/events.ts'
import { BYTES_PER_MIB, DEFAULT_HISTORY_CACHE_BUDGET, MAX_HISTORY_CACHE_MIB, type SessionHistoryCacheBudget } from '../../history-cache-budget.ts'

/** Maximum durable records retained for one inactive binding. */
export const MAX_HISTORY_CACHE_RECORDS = 1_500
const MAX_ENTRIES = 12
const MAX_POSITION_BYTES = 4 * 1024
// Window object, property slots and names, empty entries array, and hasMore boolean.
const WINDOW_OVERHEAD = 48 + 3 * 32 + 2 * ('header'.length + 'entries'.length + 'hasMore'.length) + 32 + 8
const ARRAY_ELEMENT_OVERHEAD = 8

/** Durable records from one accepted journal cut. */
export interface DurableHistoryWindow {
  readonly header: SessionWireHeader
  readonly entries: readonly SessionLiveEventEntry[]
  readonly hasMore: boolean
}

/** One live owner/route authorization. Identity changes whenever a physical grant ends. */
export interface HistoryAuthorization {
  readonly ownerEpoch: SessionHistoryOwner['ownerEpoch']
  readonly route?: SessionHistoryRoute
}

interface RetainedWindow {
  readonly window: DurableHistoryWindow
  readonly weight: number
}

interface CacheEntry {
  readonly address: SessionAddress
  readonly route: SessionHistoryRoute | undefined
  readonly history: RetainedWindow | undefined
  readonly positions: ReadonlyMap<string, { readonly value: string; readonly bytes: number }>
  readonly weight: number
}

/**
 * Check whether a revoked or removed Session is part of an address.
 * @param address - complete ordinary or direct subagent address.
 * @param sessionId - changed Session identity.
 * @returns whether the address identifies that Session directly or depends on it as a parent.
 */
export function historyDependsOn(address: SessionAddress, sessionId: SessionId): boolean {
  return address.kind === 'session' ? address.sessionId === sessionId
    : address.childSessionId === sessionId || address.parentSessionId === sessionId
}

/**
 * Resolve the Zen virtual Host from both ends of an address.
 * @param address - complete ordinary or direct subagent address.
 * @returns Zen server id, an empty string for a malformed/mixed route, or undefined for local history.
 */
export function historyServer(address: SessionAddress): string | undefined {
  const routeOf = (id: SessionId): string | undefined => id.startsWith('zr~')
    ? /^zr~([0-9a-f]{8})~/u.exec(id)?.[1] ?? ''
    : undefined
  if (address.kind === 'session') return routeOf(address.sessionId)
  const parent = routeOf(address.parentSessionId)
  return parent === routeOf(address.childSessionId) ? parent : ''
}

function cacheKey(address: SessionAddress, authorization: HistoryAuthorization): string {
  const route = authorization.route
  const ids = address.kind === 'session' ? [address.sessionId] : [address.parentSessionId, address.childSessionId, address.mode]
  return JSON.stringify([authorization.ownerEpoch, route?.serverId, route?.routeEpoch, address.kind, ...ids])
}

/** LRU owned by the Client Session Manager. Local entries freeze across brief event-stream loss. */
export class SessionHistoryCache {
  private readonly entries = new Map<string, CacheEntry>()
  private weight = 0
  private entryBudget = DEFAULT_HISTORY_CACHE_BUDGET.historyCacheSessionMiB * BYTES_PER_MIB
  private pageBudget = DEFAULT_HISTORY_CACHE_BUDGET.historyCachePageMiB * BYTES_PER_MIB
  private generation: number | undefined
  private lastGeneration: number | undefined
  private rejected = false
  private authorizedOwner: HistoryAuthorization | undefined
  private lastOwnerEpoch: SessionHistoryOwner['ownerEpoch'] | undefined
  private readonly routes = new Map<string, SessionHistoryRoute>()
  private readonly routeGrants = new Map<string, HistoryAuthorization>()

  /**
   * Update the inactive cache, preserving entry recency during compaction.
   * @param budget - complete limits in MiB, ignored together if either value is invalid.
   */
  setBudget(budget: SessionHistoryCacheBudget): void {
    if (typeof budget !== 'object' || budget === null) return
    const { historyCacheSessionMiB, historyCachePageMiB } = budget
    if (!isBudgetMiB(historyCacheSessionMiB) || !isBudgetMiB(historyCachePageMiB)) return
    const entryBudget = historyCacheSessionMiB * BYTES_PER_MIB
    const pageBudget = historyCachePageMiB * BYTES_PER_MIB
    if (this.entryBudget === entryBudget && this.pageBudget === pageBudget) return
    const previousEntryLimit = this.entryLimit
    this.entryBudget = entryBudget
    this.pageBudget = pageBudget

    if (this.entryLimit < previousEntryLimit) {
      for (const [key, entry] of this.entries) {
        const historyBudget = this.historyLimit(key)
        const current = entry.history
        if (current !== undefined && current.weight > historyBudget) {
          const history = selectHistory(current.window, historyBudget, false)
          const weight = entry.weight - current.weight + (history?.weight ?? 0)
          if ((history === undefined && entry.positions.size === 0) || weight > this.entryLimit) this.delete(key)
          else {
            this.entries.set(key, { ...entry, history, weight })
            this.weight -= entry.weight - weight
          }
        } else if (entry.weight > this.entryLimit) this.delete(key)
      }
    }
    this.evictToFit(this.pageBudget, MAX_ENTRIES)
  }

  /**
   * Freeze reads and invalidate remote entries when the Connection generation changes.
   * @param generation - current Connection generation, or undefined after losing it.
   */
  connect(generation: number | undefined): void {
    if (this.generation === generation) return
    this.freeze()
    this.generation = generation
    if (generation !== undefined) this.lastGeneration = generation
    this.rejected = false
  }

  /**
   * Enable history retention under the announced browser owner.
   * @param owner - browser owner announced by the authenticated event stream.
   */
  authorize(owner: SessionHistoryOwner): void {
    if (this.generation === undefined || this.rejected) return
    if (this.authorizedOwner?.ownerEpoch === owner.ownerEpoch) return
    if (this.lastOwnerEpoch !== owner.ownerEpoch) this.invalidate(() => true)
    this.lastOwnerEpoch = owner.ownerEpoch
    this.authorizedOwner = { ownerEpoch: owner.ownerEpoch }
    this.routeGrants.clear()
  }

  /**
   * Update the relay route and evict entries from its previous epoch.
   * @param route - latest authorized availability on one Zen Host.
   */
  updateRoute(route: SessionHistoryRoute): void {
    if (this.generation === undefined || this.rejected) return
    const current = this.routes.get(route.serverId)
    if (route.available) {
      if (current?.routeEpoch === route.routeEpoch) return
      this.routes.set(route.serverId, route)
    } else {
      if (current?.routeEpoch !== route.routeEpoch) return
      this.routes.delete(route.serverId)
    }
    this.invalidateRoute(route.serverId)
  }

  /**
   * Freeze local entries on carrier loss or erase them on an authorization refusal.
   * @param generation - generation whose event stream or HTTP authorization ended.
   * @param rejected - true for a definitive authorization refusal.
   */
  end(generation: number | undefined, rejected: boolean): void {
    if (generation !== this.generation && !(rejected && this.generation === undefined && generation === this.lastGeneration)) return
    this.rejected = true
    this.freeze()
    if (rejected) this.invalidate(() => true)
  }

  /**
   * Discard a relay grant and evict entries associated with its Host.
   * @param serverId - Zen Host whose verified route is obsolete.
   */
  endRoute(serverId: string): void {
    this.routes.delete(serverId)
    this.invalidateRoute(serverId)
  }

  /**
   * Fence invalidations against the latest route announcement.
   * @param route - advertised Zen Host and epoch.
   * @returns whether a revocation belongs to the currently advertised route.
   */
  isCurrentRoute(route: Pick<SessionHistoryRoute, 'serverId' | 'routeEpoch'>): boolean {
    return this.routes.get(route.serverId)?.routeEpoch === route.routeEpoch
  }

  /**
   * Return the identity of the grant used to fence asynchronous history reads.
   * @param address - complete ordinary or direct subagent address.
   * @returns live authorization, or undefined for an unconfirmed route.
   */
  authorization(address: SessionAddress): HistoryAuthorization | undefined {
    const owner = this.authorizedOwner
    const server = historyServer(address)
    if (owner === undefined || server === undefined) return owner
    let grant = this.routeGrants.get(server)
    if (grant === undefined) {
      const route = this.routes.get(server)
      if (route === undefined) return undefined
      grant = { ownerEpoch: owner.ownerEpoch, route }
      this.routeGrants.set(server, grant)
    }
    return grant
  }

  /**
   * Read and promote a retained window only while its grant is current.
   * @param address - exact requested Session address.
   * @param grant - currently authorized owner/route.
   * @returns the last confirmed window, if still retained.
   */
  read(address: SessionAddress, grant: HistoryAuthorization): DurableHistoryWindow | undefined {
    return this.authorization(address) === grant ? this.touch(cacheKey(address, grant))?.history?.window : undefined
  }

  /**
   * Retain an accepted window or a bounded suffix starting at a durable Turn boundary.
   * @param address - address of the retained history.
   * @param grant - authorization of the accepted journal.
   * @param window - latest accepted durable window, or undefined to retain positions alone.
   * @param truncated - whether the caller dropped records from the head for the cache count limit.
   */
  retain(address: SessionAddress, grant: HistoryAuthorization, window: DurableHistoryWindow | undefined, truncated = false): void {
    if (this.authorization(address) !== grant) return
    const key = cacheKey(address, grant)
    const positions = this.entries.get(key)?.positions ?? new Map()
    const history = window === undefined ? undefined
      : selectHistory(window, this.historyLimit(key), truncated)
    this.store(key, address, grant, history, positions)
  }

  /**
   * Evict addresses and their reading positions selected by the invalidation.
   * @param matches - identifies affected addresses and their route.
   */
  invalidate(matches: (address: SessionAddress, route: SessionHistoryRoute | undefined) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (matches(entry.address, entry.route)) this.delete(key)
    }
  }

  /**
   * Read and promote an authorized consumer position.
   * @param address - current Session binding's durable address.
   * @param key - consumer-owned position key.
   * @returns a detached copy of the position, if retained for this authorization.
   */
  readPosition(address: SessionAddress, key: string): unknown {
    const grant = this.authorization(address)
    if (grant === undefined) return undefined
    const data = this.touch(cacheKey(address, grant))?.positions.get(key)
    return data === undefined ? undefined : JSON.parse(data.value)
  }

  /**
   * Store a detached position within the shared limits.
   * @param address - current Session binding's durable address.
   * @param key - consumer-owned position key.
   * @param value - a small JSON value, or undefined to remove the entry.
   */
  writePosition(address: SessionAddress, key: string, value: unknown): void {
    const grant = this.authorization(address)
    if (grant === undefined) return
    const id = cacheKey(address, grant)
    const existing = this.entries.get(id)
    const positions = new Map(existing?.positions)
    if (value === undefined) positions.delete(key)
    else {
      const keyBytes = retainedWeightWithin(key, MAX_POSITION_BYTES)
      const valueBytes = keyBytes === undefined ? undefined : retainedWeightWithin(value, MAX_POSITION_BYTES - keyBytes)
      if (keyBytes === undefined || valueBytes === undefined) return
      const bytes = keyBytes + valueBytes + 32
      const otherBytes = [...positions].reduce((total, [name, item]) => name === key ? total : total + item.bytes, 0)
      if (otherBytes + bytes > MAX_POSITION_BYTES || !isJsonValue(value)) return
      const encoded = JSON.stringify(value)
      const retained = keyBytes + 2 * encoded.length + 56
      if (otherBytes + retained > MAX_POSITION_BYTES) return
      positions.set(key, { value: encoded, bytes: retained })
    }
    this.store(id, address, grant, existing?.history, positions)
  }

  private freeze(): void {
    this.authorizedOwner = undefined
    this.routes.clear()
    this.routeGrants.clear()
    this.invalidate((_, route) => route !== undefined)
  }

  private invalidateRoute(serverId: string): void {
    this.routeGrants.delete(serverId)
    this.invalidate((_, route) => route?.serverId === serverId)
  }

  private touch(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, entry)
    }
    return entry
  }

  private delete(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.weight -= entry.weight
  }

  private store(
    key: string,
    address: SessionAddress,
    grant: HistoryAuthorization,
    history: RetainedWindow | undefined,
    positions: CacheEntry['positions'],
  ): void {
    this.delete(key)
    if (history === undefined && positions.size === 0) return
    let weight = cacheEntryOverhead(key) + (history?.weight ?? 0)
    for (const position of positions.values()) weight += position.bytes
    if (weight > this.entryLimit) return
    // Reserve room before adding the entry so combined weight stays a safe integer.
    this.evictToFit(this.pageBudget - weight, MAX_ENTRIES - 1)
    this.entries.set(key, { address, route: grant.route, history, positions, weight })
    this.weight += weight
  }

  private get entryLimit(): number {
    return Math.min(this.entryBudget, this.pageBudget)
  }

  private historyLimit(key: string): number {
    return this.entryLimit - cacheEntryOverhead(key) - MAX_POSITION_BYTES
  }

  private evictToFit(weight: number, count: number): void {
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= count && this.weight <= weight) break
      this.delete(oldest)
    }
  }
}

function isBudgetMiB(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_HISTORY_CACHE_MIB
}

function cacheEntryOverhead(key: string): number {
  return 2 * key.length + 160
}

function selectHistory(window: DurableHistoryWindow, budget: number, truncated: boolean): RetainedWindow | undefined {
  const headerWeight = retainedWeightWithin(window.header, budget - WINDOW_OVERHEAD, 1)
  if (headerWeight === undefined) return undefined
  let weight = WINDOW_OVERHEAD + headerWeight
  const { entries } = window
  const firstAllowed = Math.max(0, entries.length - MAX_HISTORY_CACHE_RECORDS)
  let start = entries.length
  let suffixWeight = weight
  for (let index = entries.length - 1; index >= firstAllowed; index -= 1) {
    const entry = entries[index]
    if (entry === undefined) break
    const measured = retainedWeightWithin(entry, budget - weight - ARRAY_ELEMENT_OVERHEAD, 2)
    if (measured === undefined) break
    weight += ARRAY_ELEMENT_OVERHEAD + measured
    if (index === 0 && !truncated) return { window, weight }
    if (entry.event.type === 'turn/start') {
      start = index
      suffixWeight = weight
    }
  }
  if (entries.length === 0 && !truncated) return { window, weight }
  if (start === entries.length) return undefined
  return { window: { header: window.header, entries: entries.slice(start), hasMore: true }, weight: suffixWeight }
}

/** Estimate retained JS heap weight with an upper bound on traversal work. */
function retainedWeightWithin(value: unknown, budget: number, initialDepth = 0): number | undefined {
  const walk = (item: unknown, remaining: number, depth: number): number | undefined => {
    if (remaining < 0 || depth > 256) return undefined
    if (typeof item === 'string') {
      const weight = 24 + 2 * item.length
      return weight <= remaining ? weight : undefined
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return remaining >= 8 ? 8 : undefined
    if (typeof item !== 'object') return undefined
    const array = Array.isArray(item)
    let weight = array ? 32 : 48
    if (weight > remaining || (array && item.length * 8 > remaining - weight)) return undefined
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      weight += array ? 8 : 32 + 2 * key.length
      const child: unknown = Reflect.get(item, key)
      if (child === undefined && !array) {
        if (weight > remaining) return undefined
        continue
      }
      const childWeight = walk(child, remaining - weight, depth + 1)
      if (childWeight === undefined) return undefined
      weight += childWeight
    }
    return weight
  }
  return walk(value, budget, initialDepth)
}
