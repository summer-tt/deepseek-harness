import { describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror, type SettingsDescribeView } from '../src/client/settings-mirror.ts'

/** What a Remote call answers with: no carrier envelope, and a typed failure. */
type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; error: RemoteError }

function ok<T>(value: T): Answer<T> {
  return { ok: true, value }
}

function rejected<T>(message: string): Answer<T> {
  return { ok: false, error: new RemoteError('settings/rejected', message, { ns: 'theme' }) }
}

/** The providing plugin's context, scripted down to the one method the mirror calls. */
function ctxWith(describeCall: unknown) {
  return { remote: { settings: { describe: describeCall } } } as never
}

function view(ns: string, revision = 0): SettingsNamespaceView {
  return { ns, schema: {}, value: { field: ns }, autoGenerate: true, applies: 'live', secrets: [], revision }
}

function described(namespaces: SettingsNamespaceView[]): Answer<SettingsDescribeView> {
  return ok({ writable: true, hasDocument: true, namespaces })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('SettingsDescribeMirror', () => {
  it('folds loads before the wire read into it, and mid-flight loads into one rerun', async () => {
    const gate = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    const first = mirror.load()
    // Issued before the wire read goes out: covered by that read, no rerun.
    const early = mirror.load()
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(1)
    // Issued while the read is on the wire: exactly one rerun, however many.
    const mid = mirror.load()
    const midToo = mirror.load()
    gate.resolve(described([view('theme', 0)]))
    await Promise.all([first, early, mid, midToo])
    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(mirror.getSnapshot().status).toBe('ready')
    expect(mirror.namespace('theme')?.revision).toBe(1)
  })

  it('keeps the last good view when a later refresh fails, recording the failure', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 2)]))
      .mockRejectedValueOnce(new Error('host gone'))
      .mockResolvedValueOnce(rejected('busy'))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    await mirror.load()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: 'host gone' })
    expect(mirror.namespace('theme')?.revision).toBe(2)
    await mirror.load()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: 'busy' })
    expect(mirror.getSnapshot().view?.namespaces).toHaveLength(1)
  })

  it('returns to idle after a first read that never succeeded, so ensure retries', async () => {
    const describeCall = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.ensure()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'idle', view: undefined, error: 'offline' })
    await mirror.ensure()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(describeCall).toHaveBeenCalledTimes(2)
  })

  it('treats ensure as a no-op once ready', async () => {
    const describeCall = vi.fn().mockResolvedValue(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.ensure()
    await mirror.ensure()
    await mirror.ensure()
    expect(describeCall).toHaveBeenCalledTimes(1)
  })

  it('acceptView folds one write answer into the held view without a wire read', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 1), view('locale', 4)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const seen: number[] = []
    mirror.subscribe(() => { seen.push(mirror.namespace('theme')?.revision ?? -1) })
    expect(mirror.acceptView(view('theme', 9), mirror.getWriteEpoch())).toBe(true)
    expect(mirror.namespace('theme')?.revision).toBe(9)
    expect(mirror.namespace('locale')?.revision).toBe(4)
    expect(seen).toEqual([9])
    expect(describeCall).toHaveBeenCalledTimes(1)
  })

  it('preserves the held view when a same-revision answer carries older values or metadata', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described([view('theme', 4)]))
      .mockResolvedValueOnce(described([{ ...view('theme', 4), autoGenerate: false }]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const epoch = mirror.getWriteEpoch()
    await mirror.documentUpdated('theme', 4)
    expect(mirror.acceptView({ ...view('theme', 4), value: { field: 'obsolete' } }, epoch)).toBe(false)
    expect(mirror.namespace('theme')).toMatchObject({ autoGenerate: false, value: { field: 'theme' } })
    expect(describeCall).toHaveBeenCalledTimes(2)
  })

  it('acceptView before any answer is a no-op instead of inventing a document', () => {
    const describeCall = vi.fn()
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    expect(mirror.acceptView(view('theme', 1), mirror.getWriteEpoch())).toBe(false)
    expect(mirror.getSnapshot()).toEqual({ status: 'idle', view: undefined, error: null })
  })

  it('acceptView appends a namespace the held view has not seen yet', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    expect(mirror.acceptView(view('fresh-ns', 0), mirror.getWriteEpoch())).toBe(true)
    expect(mirror.namespace('fresh-ns')).toBeDefined()
    expect(mirror.getSnapshot().view?.namespaces).toHaveLength(2)
  })

  it('discards reads and writes older than a notification while rerunning the read', async () => {
    const stale = deferred<Answer<SettingsDescribeView>>()
    const current = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 4)]))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise)
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const seen: Array<number | undefined> = []
    mirror.subscribe(() => { seen.push(mirror.namespace('theme')?.revision) })
    const epoch = mirror.getWriteEpoch()
    const reading = mirror.load()
    await Promise.resolve()
    const refreshing = mirror.documentUpdated('theme', 7)
    expect(mirror.acceptView(view('theme', 6), epoch)).toBe(false)
    stale.resolve(described([view('theme', 5)]))
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([])
    current.resolve(described([view('theme', 7)]))
    await Promise.all([reading, refreshing])
    expect(seen).toEqual([7])
  })

  it('reads the new connection immediately and keeps the old view until its baseline arrives', async () => {
    const stale = deferred<Answer<SettingsDescribeView>>()
    const baseline = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 8)]))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(baseline.promise)
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const epoch = mirror.getWriteEpoch()
    const oldRead = mirror.load()
    await Promise.resolve()
    const reset = mirror.resetConnection()
    const resetEpoch = mirror.getWriteEpoch()
    expect(resetEpoch).not.toBe(epoch)
    expect(mirror.acceptView(view('theme', 9), epoch)).toBe(false)
    expect(mirror.acceptView(view('theme', 1), resetEpoch)).toBe(false)
    expect(mirror.namespace('theme')?.revision).toBe(8)
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(3)
    stale.resolve(described([view('theme', 10)]))
    await Promise.resolve()
    expect(mirror.ensure()).toBe(reset)
    expect(mirror.namespace('theme')?.revision).toBe(8)
    baseline.resolve(described([view('theme', 1)]))
    await Promise.all([oldRead, reset])
    expect(mirror.acceptView(view('theme', 11), epoch)).toBe(false)
    expect(mirror.acceptView(view('theme', 2), resetEpoch)).toBe(true)
    expect(mirror.namespace('theme')?.revision).toBe(2)
    expect(describeCall).toHaveBeenCalledTimes(3)
  })

  it('rejects partial views of removed namespaces until a describe shows them again', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 4)]))
      .mockResolvedValueOnce(described([]))
      .mockResolvedValueOnce(described([view('theme', 6)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const epoch = mirror.getWriteEpoch()
    await mirror.documentUpdated('theme', 5)
    expect(mirror.acceptView(view('theme', 4), epoch)).toBe(false)
    expect(mirror.acceptView(view('theme', 6), epoch)).toBe(false)
    expect(mirror.namespace('theme')).toBeUndefined()
    await mirror.documentUpdated('theme', 6)
    expect(mirror.acceptView(view('theme', 7), epoch)).toBe(true)
    expect(mirror.namespace('theme')?.revision).toBe(7)
  })

  it('requires a lower full view to confirm revision wraparound', async () => {
    const checkOldNotice = deferred<Answer<SettingsDescribeView>>()
    const checkReset = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 8), view('locale', 3)]))
      .mockReturnValueOnce(checkOldNotice.promise)
      .mockReturnValueOnce(checkReset.promise)
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const epoch = mirror.getWriteEpoch()
    const oldNotice = mirror.documentUpdated('theme', 4)
    expect(mirror.getWriteEpoch()).toBe(epoch)
    expect(mirror.acceptView(view('theme', 9), epoch)).toBe(false)
    checkOldNotice.resolve(described([view('theme', 8), view('locale', 3)]))
    await oldNotice
    expect(mirror.getWriteEpoch()).toBe(epoch)
    expect(mirror.acceptView(view('theme', 9), epoch)).toBe(true)
    const providerReset = mirror.documentUpdated('theme', 0)
    expect(mirror.acceptView(view('locale', 4), epoch)).toBe(false)
    checkReset.resolve(described([view('theme', 0), view('locale', 0)]))
    await providerReset
    expect(mirror.getWriteEpoch()).not.toBe(epoch)
    expect(mirror.acceptView(view('locale', 4), epoch)).toBe(false)
    expect(mirror.acceptView(view('theme', 1), mirror.getWriteEpoch())).toBe(true)
  })

  it('establishes a new baseline when a prior provider had only announced its revision', async () => {
    const read = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('locale', 3)]))
      .mockReturnValueOnce(read.promise)
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const epoch = mirror.getWriteEpoch()
    const refreshing = mirror.documentUpdated('theme', 9)
    await Promise.resolve()
    read.resolve(described([view('theme', 0), view('locale', 4)]))
    await refreshing
    expect(mirror.getWriteEpoch()).not.toBe(epoch)
    expect(mirror.acceptView(view('theme', 10), epoch)).toBe(false)
    expect(mirror.acceptView(view('theme', 1), mirror.getWriteEpoch())).toBe(true)
  })

  it('remembers when the first document after reset omits a previously served namespace', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 4)]))
      .mockResolvedValueOnce(described([]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const reset = mirror.resetConnection()
    const epoch = mirror.getWriteEpoch()
    await reset
    expect(mirror.acceptView(view('theme', 5), epoch)).toBe(false)
    expect(mirror.namespace('theme')).toBeUndefined()
    expect(mirror.acceptView(view('unseen', 0), epoch)).toBe(true)
  })

  it('never loses a load landing between a run settling and its slot clearing', async () => {
    // Regression: with the in-flight slot cleared by a promise .finally(),
    // a load() in the one-microtask gap after the rerun check marked a rerun
    // nobody read, and that refresh never reached the wire.
    const describeCall = vi.fn().mockResolvedValue(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    void mirror.load()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(1) })
    void mirror.load()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(2) })
    void mirror.load()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(3) })
  })

  it('starts no second run for a load issued inside the loading publish', async () => {
    const gate = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn().mockReturnValue(gate.promise)
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    let reentered = false
    const unsubscribe = mirror.subscribe(() => {
      if (reentered) return
      reentered = true
      void mirror.load()
    })
    const loading = mirror.load()
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(1)
    gate.resolve(described([view('theme', 1)]))
    await loading
    unsubscribe()
    // The reentrant load folded into the first run rather than racing it.
    expect(describeCall).toHaveBeenCalledTimes(1)
    expect(mirror.getSnapshot().status).toBe('ready')
  })

  it('lets the first read cover a write folded inside the loading publish', async () => {
    const describeCall = vi.fn().mockResolvedValue(described([view('theme', 2)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    const unsubscribe = mirror.subscribe(() => {
      unsubscribe()
      mirror.acceptView(view('theme', 2), mirror.getWriteEpoch())
    })

    await mirror.load()

    expect(describeCall).toHaveBeenCalledTimes(1)
    expect(mirror.getSnapshot().status).toBe('ready')
    expect(mirror.namespace('theme')?.revision).toBe(2)
  })

  it('re-reads after a folded write invalidates an in-flight document', async () => {
    const slow = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 4), view('locale', 1)]))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(described([view('theme', 5), view('locale', 2)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    expect(describeCall).toHaveBeenCalledTimes(1)
    const stale = mirror.load()
    await Promise.resolve()
    mirror.acceptView(view('theme', 5), mirror.getWriteEpoch())
    slow.resolve(described([view('theme', 4), view('locale', 2)]))
    await stale
    expect(describeCall).toHaveBeenCalledTimes(3)
    expect(mirror.namespace('theme')?.revision).toBe(5)
    expect(mirror.namespace('locale')?.revision).toBe(2)
  })

  it('re-reads after a pre-answer write invalidates the in-flight document', async () => {
    const slow = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(described([view('theme', 2)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    const loading = mirror.load()
    await Promise.resolve()
    mirror.acceptView(view('theme', 2), mirror.getWriteEpoch())
    slow.resolve(described([view('theme', 1)]))
    await loading
    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(mirror.namespace('theme')?.revision).toBe(2)
  })
})
