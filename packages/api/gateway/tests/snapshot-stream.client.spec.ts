import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import {
  RemoteSnapshotStream,
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteStreamItem,
} from '../src/client/index.ts'

type Value = { readonly kind: 'snapshot'; readonly n: number } | { readonly kind: 'delta'; readonly n: number }

interface Generation {
  readonly values?: readonly (Value | Promise<Value>)[]
  readonly terminal?: Error
  readonly hold?: boolean
}

interface SnapshotFixture {
  readonly consumer: RemoteSnapshotStream<Value, Value>
  readonly calls: string[]
  readonly failed: ReturnType<typeof vi.fn>
  publish(available: boolean): void
}

const GENERATION = { id: 1, host: { home: '/home/fixture' } }

const snapshot = (n: number): Value => ({ kind: 'snapshot', n })
const delta = (n: number): Value => ({ kind: 'delta', n })

function scripted(generations: Generation[], opened?: () => void) {
  return (signal: AbortSignal): AsyncIterable<Value> => ({
    async * [Symbol.asyncIterator](): AsyncIterator<Value> {
      const generation = generations.shift()
      if (generation === undefined) throw new Error('fixture has no snapshot generation')
      opened?.()
      for (const value of generation.values ?? []) yield await value
      if (generation.terminal !== undefined) throw generation.terminal
      if (generation.hold === true && !signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
    },
  })
}

function fixture(generations: Generation[], initiallyAvailable = true): SnapshotFixture {
  let current: ReturnType<ConnectionHandle['generation']['getSnapshot']> = initiallyAvailable ? GENERATION : undefined
  const listeners = new Set<() => void>()
  const calls: string[] = []
  const failed = vi.fn()
  const stream = new RemoteStream<Value>({
    generation: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }, {
    name: 'fixture snapshot',
    open: scripted(generations),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('accepted snapshot generation ended')
      : new Error('snapshot generation ended before its opening snapshot'),
  })
  const consumer = new RemoteSnapshotStream<Value, Value>(stream, {
    name: 'fixture snapshot',
    isSnapshot: (value): value is Value => value.kind === 'snapshot',
    replace: (value) => { calls.push(`replace:${value.n}`) },
    update: (value) => { calls.push(`update:${value.n}`) },
    failed,
  })
  return {
    consumer,
    calls,
    failed,
    publish: (available) => {
      current = available ? GENERATION : undefined
      for (const listener of listeners) listener()
    },
  }
}

/** Remote stream whose item delivery, generation, and cancellation the test controls. */
function controlled(items: RemoteStreamItem<Value>[]): SnapshotFixture {
  const lifetime = new AbortController()
  const calls: string[] = []
  const failed = vi.fn()
  const iterator = {
    next: () => {
      const item = items.shift()
      return item === undefined
        ? Promise.resolve({ done: true as const, value: undefined })
        : Promise.resolve({ done: false as const, value: item })
    },
    return: async () => ({ done: true as const, value: undefined }),
  }
  const stream = {
    signal: lifetime.signal,
    restart: () => {},
    dispose: async () => { lifetime.abort() },
    [Symbol.asyncIterator]: () => iterator,
  } as unknown as RemoteStream<Value>
  const consumer = new RemoteSnapshotStream<Value, Value>(stream, {
    name: 'fixture snapshot',
    isSnapshot: (value): value is Value => value.kind === 'snapshot',
    replace: (value) => { calls.push(`replace:${value.n}`) },
    update: (value) => { calls.push(`update:${value.n}`) },
    failed,
  })
  return { consumer, calls, failed, publish: () => {} }
}

const item = (generation: number, value: Value, signal: AbortSignal): RemoteStreamItem<Value> => (
  { generation, value, signal, accept: vi.fn() }
)

describe('RemoteSnapshotStream', () => {
  it('replaces from the opening snapshot and applies later deltas once across repeated starts', async () => {
    const live = Promise.withResolvers<Value>()
    const current = fixture([{ values: [snapshot(1), delta(1), live.promise], hold: true }])

    current.consumer.start()
    current.consumer.start()
    await vi.waitFor(() => { expect(current.calls).toEqual(['replace:1', 'update:1']) })
    live.resolve(delta(2))
    await vi.waitFor(() => { expect(current.calls).toEqual(['replace:1', 'update:1', 'update:2']) })
    expect(current.failed).not.toHaveBeenCalled()
    await current.consumer.dispose()
  })

  it('retains the published snapshot across a carrier loss and accepts the replacement snapshot', async () => {
    const live = Promise.withResolvers<Value>()
    const lost = fixture([
      { values: [snapshot(1), delta(1)], terminal: new RemoteStreamCarrierError('carrier lost') },
      { values: [snapshot(2), live.promise], hold: true },
    ])

    lost.consumer.start()
    await vi.waitFor(() => { expect(lost.calls).toEqual(['replace:1', 'update:1', 'replace:2']) })
    live.resolve(delta(3))
    await vi.waitFor(() => { expect(lost.calls).toContain('update:3') })
    expect(lost.failed).not.toHaveBeenCalled()
    await lost.consumer.dispose()
  })

  it('restarts into a fresh physical generation without discarding the published snapshot', async () => {
    const current = fixture([
      { values: [snapshot(1)], hold: true },
      { values: [snapshot(2), delta(2)], hold: true },
    ])
    current.consumer.start()
    await vi.waitFor(() => { expect(current.calls).toEqual(['replace:1']) })

    current.consumer.restart()
    await vi.waitFor(() => { expect(current.calls).toEqual(['replace:1', 'replace:2', 'update:2']) })
    expect(current.failed).not.toHaveBeenCalled()
    await current.consumer.dispose()
  })

  it('skips a cancelled frame from a generation that was replaced before consumption', async () => {
    const cancelled = new AbortController()
    const current = new AbortController()
    cancelled.abort()
    const stream = controlled([
      item(1, snapshot(1), cancelled.signal),
      item(1, delta(1), cancelled.signal),
      item(2, snapshot(2), current.signal),
      item(2, delta(2), current.signal),
    ])

    stream.consumer.start()
    await vi.waitFor(() => { expect(stream.calls).toEqual(['replace:2', 'update:2']) })
    expect(stream.failed).not.toHaveBeenCalled()
    await stream.consumer.dispose()
  })

  it('reports a delta that arrives before the opening snapshot of its generation', async () => {
    const initial = fixture([{ values: [delta(1)], hold: true }])
    initial.consumer.start()
    await vi.waitFor(() => { expect(initial.failed).toHaveBeenCalledOnce() })
    expect(initial.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture snapshot emitted an update before its opening snapshot',
    })
    expect(initial.calls).toEqual([])
    await initial.consumer.dispose()

    const resumed = fixture([
      { values: [snapshot(1), delta(1)], terminal: new RemoteStreamCarrierError('carrier lost') },
      { values: [delta(2)], hold: true },
    ])
    resumed.consumer.start()
    await vi.waitFor(() => { expect(resumed.failed).toHaveBeenCalledOnce() })
    expect(resumed.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture snapshot emitted an update before its opening snapshot',
    })
    expect(resumed.calls).toEqual(['replace:1', 'update:1'])
    await resumed.consumer.dispose()
  })

  it('reports a second snapshot inside one generation', async () => {
    const duplicate = fixture([{ values: [snapshot(1), snapshot(2)], hold: true }])
    duplicate.consumer.start()
    await vi.waitFor(() => { expect(duplicate.failed).toHaveBeenCalledOnce() })
    expect(duplicate.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture snapshot emitted more than one opening snapshot',
    })
    expect(duplicate.calls).toEqual(['replace:1'])
    await duplicate.consumer.dispose()
  })

  it('suppresses a protocol failure that surfaces after disposal begins', async () => {
    const current = new AbortController()
    const late = Promise.withResolvers<IteratorResult<RemoteStreamItem<Value>>>()
    let reads = 0
    const lifetime = new AbortController()
    const calls: string[] = []
    const failed = vi.fn()
    const iterator = {
      next: () => {
        reads++
        if (reads === 1) {
          return Promise.resolve({ done: false as const, value: item(1, snapshot(1), current.signal) })
        }
        return late.promise
      },
      return: async () => ({ done: true as const, value: undefined }),
    }
    const stream = {
      signal: lifetime.signal,
      restart: () => {},
      dispose: async () => { lifetime.abort() },
      [Symbol.asyncIterator]: () => iterator,
    } as unknown as RemoteStream<Value>
    const consumer = new RemoteSnapshotStream<Value, Value>(stream, {
      name: 'fixture snapshot',
      isSnapshot: (value): value is Value => value.kind === 'snapshot',
      replace: (value) => { calls.push(`replace:${value.n}`) },
      update: (value) => { calls.push(`update:${value.n}`) },
      failed,
    })
    consumer.start()
    await vi.waitFor(() => { expect(calls).toEqual(['replace:1']) })
    await vi.waitFor(() => { expect(reads).toBe(2) })

    const closing = consumer.dispose()
    late.resolve({ done: false, value: item(1, snapshot(2), current.signal) })
    await closing

    expect(calls).toEqual(['replace:1'])
    expect(failed).not.toHaveBeenCalled()
  })
})
