/** Follow-tail ownership, saved-position restoration, and sampled reader movement. */
import { useLayoutEffect, useState } from 'react'
import type { ChatScrollPosition, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatViewport, ViewportLanding, ViewportScroll } from './use-chat-viewport.ts'
import { useScrollFollow, type ScrollFollow } from './use-scroll-follow.ts'

const FOLLOW_THRESHOLD = 24
const SCROLL_SAMPLE_INTERVAL_MS = 500

/** Reading facts that affect Chat chrome and initial rail placement. */
export interface ChatReadingState {
  readonly initialized: boolean
  readonly followingTail: boolean
  readonly activeTurn: number | null
}

/** Settled reader position delivered to history-navigation policy. */
export interface ReadingSample {
  readonly position: ChatScrollPosition | null
  readonly movedByReader: boolean
  readonly followingTail: boolean
}

type PositionStore = ChatViewSlotProps['chatScroll']

/** Owns reading policy and its cancellable sampling work, without DOM access. */
export class ChatReading {
  private sampleTimer: number | null = null
  private probeFrame: number | null = null
  private sampled: ((sample: ReadingSample) => void) | null = null
  private position: ChatScrollPosition | null = null
  private reconciliationInterrupted = false
  private innerCapture: (() => ChatScrollPosition | null) | null = null

  constructor(
    private readonly viewport: ChatViewport,
    private store: PositionStore,
    private state: ChatReadingState,
    private readonly onChange: (state: ChatReadingState) => void,
    private readonly follow: ScrollFollow,
  ) {}

  /**
   * Expose pending reader ownership to navigation and resize handlers.
   * @returns whether reader input still awaits interval or scrollend sampling.
   */
  get pending(): boolean { return this.sampleTimer !== null }
  /**
   * Expose the active follow policy.
   * @returns whether content growth retains bottom-follow ownership.
   */
  get followingTail(): boolean { return this.state.followingTail }

  /**
   * Adopt the committed Session's scroll memory.
   * @param store - scroll memory for the current Session.
   */
  setStore(store: PositionStore): void {
    if (store === this.store) return
    this.cancelPending()
    this.store = store
    this.position = null
    this.reconciliationInterrupted = false
  }

  /**
   * Expose the position used for history reconciliation.
   * @returns Last position unless a new reader gesture has superseded it.
   */
  get currentPosition(): ChatScrollPosition | null { return this.reconciliationInterrupted ? null : this.position }

  /**
   * Read whether reconciliation is suspended pending the browser's scroll delivery.
   * @returns Whether a reader gesture is newer than the last measured position.
   */
  get pendingReconciliationInterruption(): boolean { return this.reconciliationInterrupted }

  /** Reader input before a scroll delivery supersedes the previous automatic target. */
  interruptReconciliation(): void { this.reconciliationInterrupted = true }

  /**
   * Connect history policy to settled reading observations.
   * @param sampled - receives settled reader positions.
   * @returns a disposer that disconnects only this listener.
   */
  connect(sampled: (sample: ReadingSample) => void): () => void {
    this.sampled = sampled
    return () => { if (this.sampled === sampled) this.sampled = null }
  }

  /** Keep the latest delivered reader position while the viewport and handle are still valid. */
  savePendingPosition(): void {
    if (!this.pending) return
    if (this.innerCapture !== null) {
      const position = this.innerCapture()
      if (position !== null) this.remember(position)
      return
    }
    const scroll = this.viewport.readScroll()
    if (scroll?.movedByReader !== true) return
    if (this.follow.nearBottom(scroll.metrics)) { this.remember(null); return }
    const position = this.viewport.capturePosition()
    if (position !== null) this.remember(position)
  }

  /** Cancel timers and animation frames and detach the sample listener. */
  dispose(): void {
    this.cancelPending()
    this.sampled = null
  }

  /** Release bottom follow and pending sampling for navigation or paging. */
  pauseFollowing(): void {
    this.cancelPending()
    this.publish({ ...this.state, followingTail: false })
  }

  /**
   * Land at the current floor and clear saved reader position.
   * @param behavior - immediate positioning, or one native animation when the reader's own input moved the tail.
   */
  followTail(behavior: 'instant' | 'smooth' = 'instant'): void {
    const landing = this.viewport.scrollToBottom(this.follow, behavior)
    if (landing === null) return
    this.cancelPending()
    this.commit(landing, true, this.viewport.latestTurn)
  }

  /**
   * Follow the tail on the active fold's animation clock.
   * @param input - whether the reader's own input requests the landing rather than a content change.
   * @returns whether a fold batch owns the tail movement instead of a separate scroll animation.
   */
  followInputFold(input: boolean): boolean {
    this.cancelPending()
    return this.viewport.followInputFold(this.follow, input)
  }

  /**
   * Let fold batches read follow intent and commit their tail landings.
   * @returns a disposer that disconnects this reading policy from the viewport.
   */
  bindFolds(): () => void {
    return this.viewport.bindReader({
      follow: this.follow,
      landedAtTail: (landing) => {
        this.cancelPending()
        this.commit(landing, true, this.viewport.latestTurn)
      },
      pending: () => this.pending,
    })
  }

  /** Stop a native follow animation where it is; the next sampled position decides follow intent. */
  interruptFollow(): void {
    this.viewport.interruptFollow(this.follow)
  }

  /**
   * Restore legacy position geometry, or follow the tail when none is saved.
   * @param saved - position to restore, defaulting to stored reader intent.
   */
  restore(saved = this.store.read()): void {
    if (saved === null) { this.followTail(); return }
    const landing = this.viewport.restore(saved)
    if (landing === null) return
    this.cancelPending()
    const following = this.follow.nearBottom(landing.metrics)
    this.commit(landing, following, following ? this.viewport.latestTurn : this.state.activeTurn, following)
    if (!this.state.followingTail && landing.position === null) {
      const position = this.viewport.capturePosition()
      if (position !== null) this.remember(position)
    }
    this.refreshActiveTurn()
  }

  /**
   * Adopt a known landing without rediscovering its anchor.
   * @param landing - measured navigation result that replaces pending reader input.
   */
  acceptNavigation(landing: ViewportLanding): void {
    this.cancelPending()
    const following = this.follow.nearBottom(landing.metrics)
    this.commit(landing, following, landing.turn ?? (following ? this.viewport.latestTurn : this.state.activeTurn))
  }

  /**
   * Retain reading policy while history changes the anchor's geometry.
   * @param landing - compensated position that retains the current reading policy.
   * @param providedAnchor - durable restoration keeps explicit reading intent even when it clamps to a short window.
   */
  preservePosition(landing: ViewportLanding, providedAnchor = false): void {
    this.cancelPending()
    const { floor, height } = landing.metrics
    const following = this.state.followingTail || (!providedAnchor && height > 0 && floor <= 0.5)
    this.commit(landing, following, following ? this.viewport.latestTurn : this.state.activeTurn)
  }

  /**
   * Save reader input inside a process group independently of outer scroll position.
   * @param capture - measures its visible member relative to both scroll containers.
   */
  onInnerScroll(capture: () => ChatScrollPosition | null): void {
    this.innerCapture = capture
    this.sampleTimer ??= window.setTimeout(this.flushSample, SCROLL_SAMPLE_INTERVAL_MS)
    this.publish({ ...this.state, initialized: true, followingTail: false })
  }

  /**
   * Handle pinned layout movement and reader arrivals at the floor immediately.
   * @param scroll - attributed scroll delivery; other reader movement remains pending until sampled.
   */
  readonly onScroll = (scroll: ViewportScroll): void => {
    // Native follow animation progress is not reader movement; scrollend settles it.
    if (this.follow.animating) return
    if (scroll.movedByReader) this.innerCapture = null
    if ((!scroll.movedByReader && this.state.followingTail)
      || (scroll.movedByReader && Math.abs(scroll.metrics.top - scroll.metrics.floor) < 1)) {
      this.followTail()
      this.sampled?.({ position: null, movedByReader: scroll.movedByReader, followingTail: true })
      return
    }
    this.sampleTimer ??= window.setTimeout(this.flushSample, SCROLL_SAMPLE_INTERVAL_MS)
  }

  /**
   * Settle pending reader movement; only the outer scroller can finish its native follow animation.
   * @param outer - whether the event belongs to the outer scroller rather than a process body.
   */
  readonly onScrollEnd = (outer = true): void => {
    if (this.follow.animating) {
      if (!outer) return
      const scroll = this.viewport.readScroll()
      if (scroll === null) return
      if (this.follow.settle(scroll.metrics)) {
        this.followTail()
        return
      }
      this.viewport.acknowledge(scroll.metrics)
      this.publish({ ...this.state, followingTail: false })
      this.refreshActiveTurn()
      return
    }
    this.flushSample()
  }

  /** Reconcile a layout change without overriding unsampled reader input. */
  onResize(): void {
    if (this.pending) return
    if (this.state.followingTail) this.followTail()
    else this.refreshActiveTurn()
  }

  /** Resolve the active turn from tail ownership or a coalesced reading-line probe. */
  refreshActiveTurn(): void {
    if (this.pending) return
    if (this.state.followingTail) {
      this.publish({ ...this.state, initialized: true, activeTurn: this.viewport.latestTurn })
      return
    }
    if (this.probeFrame !== null) return
    if (typeof requestAnimationFrame !== 'function') this.probe()
    else this.probeFrame = requestAnimationFrame(this.probe)
  }

  private commit(
    landing: ViewportLanding, followingTail: boolean, activeTurn: number | null, initialized = true,
  ): void {
    if (followingTail) this.remember(null)
    else if (landing.position !== null) this.remember(landing.position)
    this.publish({ initialized, followingTail, activeTurn })
  }

  /** Keep a missing anchor pending while showing the currently available history. */
  waitForPosition(): void {
    this.cancelPending()
    this.publish({ initialized: true, followingTail: false, activeTurn: this.viewport.latestTurn })
  }

  private remember(position: ChatScrollPosition | null): void {
    this.position = position
    this.reconciliationInterrupted = false
    this.store.save(position)
  }

  private publish(state: ChatReadingState): void {
    this.follow.setFollowing(state.followingTail)
    if (state.initialized === this.state.initialized && state.followingTail === this.state.followingTail
      && state.activeTurn === this.state.activeTurn) return
    this.state = state
    this.onChange(state)
  }

  private cancelPending(): void {
    if (this.sampleTimer !== null) window.clearTimeout(this.sampleTimer)
    if (this.probeFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.probeFrame)
    this.sampleTimer = null
    this.probeFrame = null
    this.innerCapture = null
  }

  private readonly probe = (): void => {
    this.probeFrame = null
    if (this.pending) return
    const scroll = this.viewport.readScroll()
    if (scroll === null) return
    const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics)
    this.publish({ ...this.state, initialized: true, activeTurn })
  }

  private readonly flushSample = (): void => {
    if (!this.pending) return
    const capture = this.innerCapture
    this.cancelPending()
    if (capture !== null) {
      const position = capture()
      if (position !== null) this.remember(position)
      this.refreshActiveTurn()
      this.sampled?.({ position, movedByReader: true, followingTail: false })
      return
    }
    const scroll = this.viewport.readScroll()
    if (scroll === null) return
    const followingTail = this.follow.sample(scroll.metrics, scroll.movedByReader)
    let position: ChatScrollPosition | null = null
    if (!scroll.movedByReader && followingTail) this.followTail()
    else {
      position = followingTail ? null : this.viewport.capturePosition()
      this.viewport.acknowledge(scroll.metrics)
      if (followingTail || position !== null) this.remember(position)
      const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics)
      this.publish({ initialized: true, followingTail, activeTurn })
    }
    this.sampled?.({ position, movedByReader: scroll.movedByReader, followingTail })
  }
}

/**
 * Retain reading policy and expose only changes in visible reading state.
 * @param viewport - turn-aware DOM operations.
 * @param store - Session-owned semantic scroll memory.
 * @param initialTurn - latest loaded turn before the first landing.
 * @returns the reading owner and its React-visible state.
 */
export function useChatReading(
  viewport: ChatViewport, store: PositionStore, initialTurn: number | null,
): { reading: ChatReading; state: ChatReadingState } {
  const [state, setState] = useState<ChatReadingState>(() => ({
    initialized: false,
    followingTail: store.read() === null,
    activeTurn: initialTurn,
  }))
  const follow = useScrollFollow(state.followingTail, FOLLOW_THRESHOLD + 1)
  const [reading] = useState(() => new ChatReading(viewport, store, state, setState, follow))
  useLayoutEffect(() => {
    reading.setStore(store)
    return store.registerFlush?.(() => { reading.savePendingPosition() })
  }, [reading, store])
  useLayoutEffect(() => reading.bindFolds(), [reading])
  useLayoutEffect(() => () => { reading.dispose() }, [reading])
  return { reading, state }
}
