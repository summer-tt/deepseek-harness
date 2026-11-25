import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LinuxScopeQueryScheduler } from '../src/linux-scope-query.ts'

it('rejects invalid Linux scope budgets before installing the runtime', () => {
  for (const invalid of [
    { ordinaryConcurrency: 0 }, { ordinaryConcurrency: 9 }, { priorityConcurrency: 3 },
    { ordinaryStartsPerSecond: 21 }, { priorityStartsPerSecond: 11 },
    { startsPerTurn: 5 }, { startsPerTurn: 1.5 },
  ]) expect(() => LocalSubprocessRuntime.Config(invalid)).toThrow()
  expect(() => new LocalSubprocessRuntime(new Context(), {
    ordinaryConcurrency: 1, priorityConcurrency: 1, startsPerTurn: 3,
  })).toThrow('startsPerTurn must not exceed the combined concurrency or starts-per-second limit')
})

it('preserves FIFO, reserves capacity, and cancels queued work without charging it', async () => {
  const scheduler = new LinuxScopeQueryScheduler({
    ordinaryConcurrency: 1, priorityConcurrency: 1, ordinaryStartsPerSecond: 20,
    priorityStartsPerSecond: 10, startsPerTurn: 2,
  })
  const aborter = new AbortController()
  const pending = new AbortController().signal
  const ordinary = Promise.withResolvers<undefined>()
  const firstStarted = Promise.withResolvers<undefined>()
  const first = scheduler.query('ordinary', pending, () => {
    firstStarted.resolve(undefined)
    return ordinary.promise
  })
  const cancelled = vi.fn(async () => {})
  const cancelledQuery = scheduler.query('ordinary', aborter.signal, cancelled)
  const order: string[] = []
  const follow = (lane: 'ordinary' | 'priority', name: string) => scheduler.query(lane, pending, () => {
    order.push(name)
    return Promise.resolve(name)
  })
  const second = follow('ordinary', 'ordinary 2')
  const third = follow('ordinary', 'ordinary 3')
  await firstStarted.promise
  const priority = follow('priority', 'priority')
  aborter.abort()
  try {
    await expect(cancelledQuery).resolves.toBeUndefined()
    await expect(priority).resolves.toBe('priority')
    expect(order).toEqual(['priority'])
    expect(cancelled).not.toHaveBeenCalled()
  } finally {
    ordinary.resolve(undefined)
    await Promise.all([first, second, third, priority])
  }
  expect(order).toEqual(['priority', 'ordinary 2', 'ordinary 3'])
})

it.each([
  { startsPerTurn: 1, maxBatches: 2 },
  { startsPerTurn: 4, maxBatches: 1 },
])('dispatches an eligible priority query within $maxBatches batches with startsPerTurn=$startsPerTurn', async ({
  startsPerTurn, maxBatches,
}) => {
  const scheduler = new LinuxScopeQueryScheduler({
    ordinaryConcurrency: 8, priorityConcurrency: 2, ordinaryStartsPerSecond: 20,
    priorityStartsPerSecond: 10, startsPerTurn,
  })
  const signal = new AbortController().signal
  // A priority-only dispatch gives ordinary work the next turn when both lanes are ready.
  await scheduler.query('priority', signal, () => Promise.resolve())
  const batches: string[][] = []
  let currentBatch: string[] | undefined
  const record = (name: string): void => {
    if (currentBatch === undefined) {
      currentBatch = []
      batches.push(currentBatch)
      queueMicrotask(() => { currentBatch = undefined })
    }
    currentBatch.push(name)
  }
  const ordinary = Array.from({ length: 8 }, (_, index) => scheduler.query('ordinary', signal, () => {
    record(`ordinary ${index}`)
    return Promise.resolve()
  }))
  const enqueuedAt = performance.now()
  const priority = scheduler.query('priority', signal, () => {
    record('confirmation')
    return Promise.resolve(performance.now() - enqueuedAt)
  })
  const [waitMs] = await Promise.all([priority, ...ordinary])
  const batch = batches.findIndex(entries => entries.includes('confirmation')) + 1
  expect(batch).toBeGreaterThanOrEqual(1)
  expect(batch).toBeLessThanOrEqual(maxBatches)
  expect(batches.flat().indexOf('confirmation')).toBe(1)
  expect(waitMs).toBeLessThanOrEqual(100)
})

it('does not release a start budget before the actual process start ages out', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'setTimeout', 'clearTimeout'] })
  const clock = vi.spyOn(performance, 'now')
  clock.mockReturnValue(0)
  const scheduler = new LinuxScopeQueryScheduler({
    ordinaryConcurrency: 8, priorityConcurrency: 2, ordinaryStartsPerSecond: 20,
    priorityStartsPerSecond: 10, startsPerTurn: 4,
  })
  const signal = new AbortController().signal
  const starts: number[] = []
  try {
    const pending = Array.from({ length: 21 }, (_, index) => scheduler.query('ordinary', signal, () => {
      if (index === 0) clock.mockReturnValue(100)
      starts.push(performance.now())
      return Promise.resolve()
    }))
    for (let batch = 0; batch < 5; batch += 1) await vi.advanceTimersToNextTimerAsync()
    expect(starts).toEqual(Array.from({ length: 20 }, () => 100))
    clock.mockReturnValue(1_000)
    await vi.advanceTimersByTimeAsync(950)
    const earlyStarts = starts.slice()
    clock.mockReturnValue(1_100)
    await vi.runAllTimersAsync()
    await Promise.all(pending)
    expect(earlyStarts, 'actual starts before the first dispatch boundary ages out').toHaveLength(20)
    expect(starts.at(-1)).toBe(1_100)
  } finally {
    clock.mockRestore()
    vi.useRealTimers()
  }
})

it('charges immediate failures and starts both lanes in bounded batches at the rolling-window edge', async () => {
  vi.useFakeTimers({ toFake: ['setImmediate', 'setTimeout', 'clearTimeout'] })
  const clock = vi.spyOn(performance, 'now')
  clock.mockReturnValue(0)
  const scheduler = new LinuxScopeQueryScheduler({
    ordinaryConcurrency: 4, priorityConcurrency: 2, ordinaryStartsPerSecond: 2,
    priorityStartsPerSecond: 2, startsPerTurn: 2,
  })
  const starts: string[] = []
  const failure = new Error('failed before returning a promise')
  const signal = new AbortController().signal
  const enqueue = (lane: 'ordinary' | 'priority', name: string) => scheduler.query(lane, signal, () => {
    starts.push(name)
    throw failure
  }).catch((error: unknown) => error)
  try {
    const pending = [
      enqueue('priority', 'P1'), enqueue('priority', 'P2'), enqueue('priority', 'P3'),
      enqueue('ordinary', 'O1'), enqueue('ordinary', 'O2'), enqueue('ordinary', 'O3'),
    ]
    await vi.advanceTimersToNextTimerAsync()
    expect(starts).toEqual(['P1', 'O1'])
    await vi.advanceTimersToNextTimerAsync()
    expect(starts).toEqual(['P1', 'O1', 'P2', 'O2'])
    clock.mockReturnValue(999)
    await vi.advanceTimersToNextTimerAsync()
    expect(starts).toHaveLength(4)
    clock.mockReturnValue(1_000)
    await vi.runAllTimersAsync()
    expect(starts).toEqual(['P1', 'O1', 'P2', 'O2', 'P3', 'O3'])
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 6 }, () => failure))
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    clock.mockRestore()
    vi.useRealTimers()
  }
})

const disposalBudget = {
  ordinaryConcurrency: 1,
  priorityConcurrency: 1,
  ordinaryStartsPerSecond: 1,
  priorityStartsPerSecond: 1,
  startsPerTurn: 1,
}

it('cancels its rate-delay timer when draining, leaving another scheduler rate-limited', async () => {
  vi.useFakeTimers({ now: 0, toFake: ['Date', 'setImmediate', 'setTimeout', 'clearTimeout'] })
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  try {
    const first = new LinuxScopeQueryScheduler(disposalBudget)
    const second = new LinuxScopeQueryScheduler(disposalBudget)
    const signal = new AbortController().signal
    const run = () => Promise.resolve()
    const warmup = [first.query('ordinary', signal, run), second.query('ordinary', signal, run)]
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all(warmup)
    const firstStart = vi.fn(run)
    const secondStart = vi.fn(run)
    const pending = [first.query('ordinary', signal, firstStart), second.query('ordinary', signal, secondStart)]
    await vi.advanceTimersByTimeAsync(990)
    expect(vi.getTimerCount()).toBe(2)
    expect(firstStart).not.toHaveBeenCalled()
    expect(secondStart).not.toHaveBeenCalled()
    first.beginDisposal()
    first.beginDisposal()
    await vi.advanceTimersByTimeAsync(1)
    expect(firstStart).toHaveBeenCalledOnce()
    expect(secondStart).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    await Promise.all(pending)
    expect(firstStart).toHaveBeenCalledOnce()
    expect(secondStart).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    clock.mockRestore()
    vi.useRealTimers()
  }
})

it('keeps an already scheduled batch and counts the existing query in the combined drain capacity', async () => {
  vi.useFakeTimers({ now: 0, toFake: ['Date', 'setImmediate', 'setTimeout', 'clearTimeout'] })
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  try {
    const scheduler = new LinuxScopeQueryScheduler(disposalBudget)
    const signal = new AbortController().signal
    const releaseFirst = Promise.withResolvers<undefined>()
    const releaseSecond = Promise.withResolvers<undefined>()
    const firstStart = vi.fn(() => releaseFirst.promise)
    const secondStart = vi.fn(() => releaseSecond.promise)
    const thirdStart = vi.fn(() => Promise.resolve())
    const first = scheduler.query('ordinary', signal, firstStart)
    await vi.advanceTimersByTimeAsync(0)
    expect(firstStart).toHaveBeenCalledOnce()
    const second = scheduler.query('priority', signal, secondStart)
    const third = scheduler.query('ordinary', signal, thirdStart)
    expect(vi.getTimerCount()).toBe(1)
    scheduler.beginDisposal()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(secondStart).toHaveBeenCalledOnce()
    expect(thirdStart).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    releaseSecond.resolve(undefined)
    await vi.advanceTimersByTimeAsync(1)
    expect(thirdStart).toHaveBeenCalledOnce()
    releaseFirst.resolve(undefined)
    await Promise.all([first, second, third])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    clock.mockRestore()
    vi.useRealTimers()
  }
})
