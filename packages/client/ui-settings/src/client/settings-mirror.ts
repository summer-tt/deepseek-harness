/**
 * Client mirror of the Host settings document: the one `settings.describe`
 * reader in the browser. Every settings consumer derives from this store —
 * shared entry forms through `ConfigForms.get`, cross-namespace
 * surfaces through the provider's shared describe face — so startup cost and
 * freshness are properties of this class, not of how many features own a
 * preference. The Host stays the fact source: the mirror re-reads on the
 * invalidations its owning plugin subscribes to and folds write answers in
 * through {@link SettingsDescribeMirror.acceptView}.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** The full `settings.describe` answer the mirror serves. */
export interface SettingsDescribeView {
  /** Every namespace a live Host plugin registered, as the Host reported it. */
  namespaces: readonly SettingsNamespaceView[]
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Whether a native settings document exists for the Host to open. */
  hasDocument: boolean
}

/** Mirror state every derived settings surface renders from. */
export interface SettingsMirrorSnapshot {
  /**
   * `ready` persists across later failed refreshes (the held view keeps serving);
   * `idle` means no answer is held and no read is running, so `ensure` will
   * start one.
   */
  status: 'idle' | 'loading' | 'ready'
  /** The last good answer; undefined until the first success. */
  view: SettingsDescribeView | undefined
  /** The latest refresh failure message, cleared by the next success. */
  error: string | null
}

/**
 * The mirror as cross-namespace surfaces consume it: current answer,
 * subscription, first-use read, and the write-answer fold. `load` stays off
 * this face — invalidation refreshes belong to the mirror's owning plugin.
 */
export interface SettingsDescribeFace {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Await an active read, or read if no answer is held or reset still needs a
   * complete baseline. The snapshot records any read failure.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void>
  /** @returns the mirror epoch to capture immediately before dispatching a settings write. */
  getWriteEpoch(): number
  /** @returns whether the connection has no reset baseline outstanding. */
  hasConnectionBaseline(): boolean
  /**
   * Fold a current write answer into the held document without starting a read.
   * @param view - the namespace view a settings write answered with.
   * @param epoch - the mirror epoch captured when the write was dispatched.
   * @returns whether the answer was folded and published to subscribers.
   */
  acceptView(view: SettingsNamespaceView, epoch: number): boolean
}

interface DescribeRead {
  promise: Promise<void>
  follow: (result: Promise<void>) => void
  rerun: boolean
  dispatched: boolean
}

/**
 * Serializes every Host `settings.describe` read behind one snapshot store.
 * Within a connection, concurrent {@link load} calls coalesce into one read
 * and one rerun. Reset retires the old read and starts a new baseline.
 */
export class SettingsDescribeMirror implements SettingsDescribeFace {
  private readonly store: SnapshotStore<SettingsMirrorSnapshot>
  private inFlight: DescribeRead | undefined
  private readGeneration = 0
  private writeEpoch = 0
  private awaitingConnectionBaseline = false
  private partialWritesPaused = false
  private readonly revisions = new Map<string, number>()
  private readonly notified = new Set<string>()
  private readonly removed = new Set<string>()

  /**
   * @param ctx - the providing plugin's context, whose `remote.settings`
   * namespace answers the describe read.
   */
  constructor(private readonly ctx: ClientContext) {
    this.store = createSnapshotStore<SettingsMirrorSnapshot>({
      status: 'idle',
      view: undefined,
      error: null,
    })
  }

  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsMirrorSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Refresh from the Host. Concurrent requests on one connection share the
   * current read and a rerun. Waiters follow the new read on reset.
   * @returns settlement after the refresh publishes its answer or failure.
   */
  load(): Promise<void> {
    if (this.inFlight !== undefined) {
      this.inFlight.rerun = true
      return this.inFlight.promise
    }
    // Own the slot before the loading publication can synchronously reenter load().
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const read: DescribeRead = { promise, follow: resolve, rerun: false, dispatched: false }
    this.inFlight = read
    void Promise.resolve().then(() => this.run(read)).then(resolve, reject)
    return promise
  }

  /**
   * Reuse the active read or retry an unanswered baseline.
   * @returns settlement of the current or newly started read, if any.
   */
  ensure(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight.promise
    if (this.awaitingConnectionBaseline || this.getSnapshot().status === 'idle') return this.load()
    return Promise.resolve()
  }

  /** @returns the mirror epoch to capture immediately before dispatching a settings write. */
  getWriteEpoch(): number {
    return this.writeEpoch
  }

  /** @returns whether an implicit edit can use the current connection's revision. */
  hasConnectionBaseline(): boolean {
    return !this.awaitingConnectionBaseline
  }

  /**
   * Check whether a successful answer can supply a value or a queued write's revision.
   * @param ns - the written namespace.
   * @param revision - the revision from the write answer.
   * @param epoch - the mirror epoch captured when the write was dispatched.
   * @returns whether the answer is current and the namespace has no confirmed removal.
   */
  canUseWriteRevision(ns: string, revision: number, epoch: number): boolean {
    if (epoch !== this.writeEpoch || this.awaitingConnectionBaseline || this.partialWritesPaused) return false
    return !this.removed.has(ns) && revision >= (this.revisions.get(ns) ?? revision)
  }

  /**
   * Fold a current answer into the held document without starting a read.
   * A current answer still invalidates a read in flight before the first document.
   * @param view - the namespace view a settings write answered with.
   * @param epoch - the mirror epoch captured when the write was dispatched.
   * @returns whether the answer was folded and published to subscribers.
   */
  acceptView(view: SettingsNamespaceView, epoch: number): boolean {
    if (!this.canUseWriteRevision(view.ns, view.revision, epoch)) return false
    // A notified full view may carry newer presentation policy at the same revision.
    if (this.notified.has(view.ns) && this.namespace(view.ns)?.revision === view.revision) return false
    this.revisions.set(view.ns, view.revision)
    this.invalidateRead()
    const before = this.store.getSnapshot()
    if (before.view === undefined) return false
    const namespaces = before.view.namespaces.some(row => row.ns === view.ns)
      ? before.view.namespaces.map(row => row.ns === view.ns ? view : row)
      : [...before.view.namespaces, view]
    this.store.set({ ...before, view: { ...before.view, namespaces } })
    return true
  }

  /**
   * Reconcile a Host notification with a full read dispatched after it.
   * @param ns - the namespace named by the notification.
   * @param revision - the announced namespace revision.
   * @returns settlement of the refresh.
   */
  documentUpdated(ns: string, revision: number): Promise<void> {
    this.notified.add(ns)
    const known = this.revisions.get(ns)
    if (known !== undefined && revision < known) {
      // A delayed notification and a provider restart look the same until describe answers.
      this.partialWritesPaused = true
    } else {
      this.revisions.set(ns, revision)
    }
    this.invalidateRead()
    return this.load()
  }

  /**
   * Advance the write epoch and rebuild ordering from the new connection's full document.
   * @returns settlement of the refresh.
   */
  resetConnection(): Promise<void> {
    this.writeEpoch += 1
    this.revisions.clear()
    this.notified.clear()
    this.awaitingConnectionBaseline = true
    this.partialWritesPaused = false
    // A call still waiting to dispatch can read the new connection. A dispatched
    // call may never settle, so the new connection gets its own read slot.
    const previous = this.inFlight
    if (!previous?.dispatched) return this.load()
    this.inFlight = undefined
    const refresh = this.load()
    previous.follow(refresh)
    return refresh
  }

  private invalidateRead(): void {
    this.readGeneration += 1
    if (this.inFlight !== undefined) this.inFlight.rerun = true
  }

  private publishDescribe(view: SettingsDescribeView): void {
    // Only a full read dispatched after the invalidation can establish a lower baseline.
    const resetsProvider = view.namespaces.some(row => row.revision < (this.revisions.get(row.ns) ?? row.revision))
    for (const previous of this.getSnapshot().view?.namespaces ?? []) this.removed.add(previous.ns)
    for (const ns of this.revisions.keys()) this.removed.add(ns)
    if (resetsProvider) {
      this.writeEpoch += 1
      this.revisions.clear()
    }
    for (const row of view.namespaces) {
      this.revisions.set(row.ns, row.revision)
      this.removed.delete(row.ns)
    }
    this.awaitingConnectionBaseline = false
    this.partialWritesPaused = false
    this.store.set({ status: 'ready', view, error: null })
  }

  /**
   * Convenience row lookup on the held view.
   * @param ns - namespace identity.
   * @returns the namespace view, or undefined while unanswered or unregistered.
   */
  namespace(ns: string): SettingsNamespaceView | undefined {
    return this.store.getSnapshot().view?.namespaces.find(row => row.ns === ns)
  }

  private async run(read: DescribeRead): Promise<void> {
    // The in-flight slot must clear in the same synchronous segment that
    // observes `rerun` false (and on abrupt exit): a `.finally()` on the
    // returned promise runs one microtask later, and a `load()` landing in
    // that gap would mark a rerun nobody reads, losing the read.
    try {
      do {
        const before = this.store.getSnapshot()
        if (before.status === 'idle') this.store.set({ ...before, status: 'loading' })
        // Cleared immediately before the wire read goes out: a load() marked
        // earlier (including one reentering from the loading publish above)
        // is covered by this very read, while one landing after needs the
        // rerun.
        read.rerun = false
        read.dispatched = true
        const generation = this.readGeneration
        let outcome: { view: SettingsDescribeView } | { failure: string }
        try {
          const response = await this.ctx.remote.settings.describe()
          outcome = response.ok
            ? { view: response.value }
            : { failure: response.error.message }
        } catch (error) {
          outcome = { failure: error instanceof Error ? error.message : String(error) }
        }
        if (this.inFlight !== read) return
        if (generation !== this.readGeneration) continue
        if ('view' in outcome) {
          this.publishDescribe(outcome.view)
        } else {
          const held = this.store.getSnapshot()
          // No answer yet: fall back to idle so `ensure` retries; with one, the
          // held view keeps serving and only the error field reports the miss.
          this.store.set({
            status: held.view === undefined ? 'idle' : 'ready',
            view: held.view,
            error: outcome.failure,
          })
        }
      } while (this.inFlight === read && read.rerun)
    } finally {
      if (this.inFlight === read) this.inFlight = undefined
    }
  }
}
