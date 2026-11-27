import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Reveal a saved row without dispatching a browser Find event or moving focus. */
export const CHAT_REVEAL_READING_ANCHOR = 'dsh-chat-reveal-reading-anchor'

/**
 * Optional visibility operation; its caller owns cancellation and eventually commits the attribute.
 * @param element - stable subtree root.
 * @param hidden - desired hidden state.
 * @param commit - apply the final visibility before reporting the operation complete.
 */
export type HiddenTransition = (element: HTMLElement, hidden: boolean, commit: () => void) => void

/**
 * Apply searchable hidden state without unmounting a stable subtree.
 * @param hidden - whether the subtree is currently hidden.
 * @param reveal - callback for browser find's beforematch reveal.
 * @param transition - optional caller-owned visibility operation; otherwise apply synchronously.
 * @returns ref for the stable subtree root.
 */
export function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
  transition?: HiddenTransition,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    const commit = (): void => {
      if (hidden) element.setAttribute('hidden', 'until-found')
      else element.removeAttribute('hidden')
    }
    if (transition === undefined) commit()
    else transition(element, hidden, commit)
  }, [hidden, reveal, transition])
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const revealReading = (event: Event): void => {
      event.preventDefault()
      reveal()
    }
    element.addEventListener('beforematch', reveal)
    if (hidden) element.addEventListener(CHAT_REVEAL_READING_ANCHOR, revealReading)
    return () => {
      element.removeEventListener('beforematch', reveal)
      element.removeEventListener(CHAT_REVEAL_READING_ANCHOR, revealReading)
    }
  }, [hidden, reveal])
  return ref
}
