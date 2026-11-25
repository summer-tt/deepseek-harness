/** Per-provider budgets for asynchronous Linux scope state queries. */

import { performance } from 'node:perf_hooks'

/** Independent limits for ordinary queries and termination confirmations. */
export interface ScopeQueryBudget {
  ordinaryConcurrency: number
  priorityConcurrency: number
  ordinaryStartsPerSecond: number
  priorityStartsPerSecond: number
  startsPerTurn: number
}

const SECOND_MS = 1_000

type LaneName = 'ordinary' | 'priority'

interface Lane {
  readonly capacity: number
  readonly startsPerSecond: number
  readonly starts: number[]
  readonly pending: Set<() => void>
  active: number
}

function lane(capacity: number, startsPerSecond: number): Lane {
  return { capacity, startsPerSecond, starts: [], pending: new Set(), active: 0 }
}

/** Schedule ordinary FIFO queries and reserve independent capacity for termination confirmations. */
export class LinuxScopeQueryScheduler {
  private readonly lanes: Record<LaneName, Lane>
  private disposing = false
  private nextLane: LaneName = 'priority'
  private immediate: ReturnType<typeof setImmediate> | undefined
  private timer: { handle: ReturnType<typeof setTimeout>; at: number } | undefined

  constructor(private readonly budget: ScopeQueryBudget) {
    this.lanes = {
      ordinary: lane(budget.ordinaryConcurrency, budget.ordinaryStartsPerSecond),
      priority: lane(budget.priorityConcurrency, budget.priorityStartsPerSecond),
    }
  }

  /** Drain owned queries using the combined concurrency limit without waiting for rolling start credits. */
  beginDisposal(): void {
    if (this.disposing) return
    this.disposing = true
    this.lanes.ordinary.starts.length = 0
    this.lanes.priority.starts.length = 0
    this.clearRateTimer()
    this.scheduleDispatch()
  }

  /**
   * Queue one command without starting it inline. Aborting a queued query is not an observation failure.
   * @param name - independent budget to charge for a start.
   * @param superseded - cancels only the queued request; it cannot interrupt a started query.
   * @param run - attempt the launch synchronously before returning a promise for command completion.
   * @returns the query result, or undefined if superseded before dispatch.
   */
  query<T>(name: LaneName, superseded: AbortSignal, run: () => Promise<T>): Promise<T | undefined> {
    if (superseded.aborted) return Promise.resolve(undefined)
    const current = this.lanes[name]
    const { promise, resolve, reject } = Promise.withResolvers<T | undefined>()
    const start = (): void => {
      superseded.removeEventListener('abort', cancel)
      current.active += 1
      void execute()
    }
    const cancel = (): void => {
      current.pending.delete(start)
      resolve(undefined)
      this.scheduleDispatch()
    }
    const launch = (): Promise<T> => {
      try {
        return run()
      } finally {
        // Charge after the synchronous attempt so its budget cannot expire before the start ages out.
        if (!this.disposing) current.starts.push(performance.now())
      }
    }
    const execute = async (): Promise<void> => {
      try {
        resolve(await launch())
      } catch (error) {
        reject(error)
      } finally {
        current.active -= 1
        this.scheduleDispatch()
      }
    }
    superseded.addEventListener('abort', cancel, { once: true })
    current.pending.add(start)
    this.scheduleDispatch()
    return promise
  }

  private nextStart(current: Lane, now: number): number | undefined {
    if (current.pending.size === 0) return undefined
    if (this.disposing) {
      const { ordinary, priority } = this.lanes
      return ordinary.active + priority.active < ordinary.capacity + priority.capacity ? now : undefined
    }
    if (current.active >= current.capacity) return undefined
    let expired = 0
    for (const start of current.starts) {
      if (now - start < SECOND_MS) break
      expired += 1
    }
    if (expired > 0) current.starts.splice(0, expired)
    const oldest = current.starts[0]
    return oldest !== undefined && current.starts.length >= current.startsPerSecond ? oldest + SECOND_MS : now
  }

  private scheduleDispatch(): void {
    if (this.immediate !== undefined) return
    const now = performance.now()
    const at = Math.min(
      this.nextStart(this.lanes.priority, now) ?? Infinity,
      this.nextStart(this.lanes.ordinary, now) ?? Infinity,
    )
    if (at === this.timer?.at) return
    this.clearRateTimer()
    if (at <= now) {
      this.immediate = setImmediate(() => {
        try {
          this.dispatch()
        } finally {
          this.immediate = undefined
          this.scheduleDispatch()
        }
      })
    } else if (at < Infinity) {
      this.timer = { at, handle: setTimeout(() => {
        this.timer = undefined
        this.scheduleDispatch()
      }, Math.ceil(at - now)) }
    }
  }

  private clearRateTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer.handle)
    this.timer = undefined
  }

  private dispatch(): void {
    for (let started = 0; started < this.budget.startsPerTurn; started += 1) {
      const now = performance.now()
      const priorityReady = this.nextStart(this.lanes.priority, now) === now
      const ordinaryReady = this.nextStart(this.lanes.ordinary, now) === now
      if (!priorityReady && !ordinaryReady) return
      const name = priorityReady && ordinaryReady ? this.nextLane : priorityReady ? 'priority' : 'ordinary'
      const { pending } = this.lanes[name]
      const start = pending.values().next().value
      if (start === undefined) return
      this.nextLane = name === 'priority' ? 'ordinary' : 'priority'
      pending.delete(start)
      start()
    }
  }
}
