/** Adapter from the Session's authorized JSON value to the Chat viewport's position. */
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatScrollMemory, ChatScrollPosition } from '../contract/slots.ts'

/** Position access for a view without an active authorized Session handle. */
export const EMPTY_CHAT_SCROLL: ChatScrollMemory = { read: () => null, save: () => {} }

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positionOf(value: unknown): ChatScrollPosition | null {
  if (typeof value !== 'object' || value === null) return null
  const position = value as Partial<ChatScrollPosition>
  if (typeof position.anchorKey !== 'string' || !finite(position.anchorTop) || !finite(position.scrollTop)) return null
  if (!finite(position.seq) || !Number.isSafeInteger(position.seq) || position.seq < 0) return null
  if (position.groupTop !== undefined && !finite(position.groupTop)) return null
  return { ...position, anchorKey: position.anchorKey, anchorTop: position.anchorTop, scrollTop: position.scrollTop }
}

/**
 * Obtain a handle for the epoch supplied by the committed view.
 * @param session - exact retained binding behind the view.
 * @param epoch - history generation observed by the view.
 * @param occurrence - independent position for main and embedded Chat.
 * @returns access through the generation-bound handle, when authorized.
 */
export function chatReadingPosition(
  session: SessionFace, epoch: number | undefined, occurrence: 'main' | 'embedded',
): ChatScrollMemory {
  if (session.getSnapshot().historyEpoch !== epoch) return EMPTY_CHAT_SCROLL
  const handle = session.readingPosition?.(`chat:${occurrence}`)
  if (handle === undefined) {
    let position: ChatScrollPosition | null = null
    return {
      read: () => session.getSnapshot().historyEpoch === epoch ? position : null,
      save: (value) => { if (session.getSnapshot().historyEpoch === epoch) position = value },
    }
  }
  return {
    ...(session.registerReadingPositionFlush === undefined ? {} : {
      registerFlush: (flush: () => void) => session.registerReadingPositionFlush?.(flush) ?? (() => {}),
    }),
    read: () => positionOf(handle.read()),
    save: (value) => {
      if (value === null || value.seq !== undefined) handle.write(value ?? undefined)
    },
  }
}
