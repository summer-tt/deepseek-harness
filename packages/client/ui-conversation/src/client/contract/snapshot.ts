/** Target-neutral Conversation state assembled from one Session event window. */
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewSnapshotStore } from './conversation.ts'

/** Durable coverage and reconciliation of the loaded Session log. */
export interface ConversationHistoryWindow {
  /** First durable sequence in the window, or null for an empty log. */
  readonly firstSeq: number | null
  /** Changes on a full window replacement or a non-live suffix. */
  readonly reconciliation: number
}

/** Latest registered target snapshots and their shell-level activity. */
export interface ConversationSnapshot {
  readonly views: ConversationViewSnapshotStore
  readonly activeTargets: ReadonlySet<string>
  /** Loaded log coverage. Older Conversation sources may omit this metadata. */
  readonly history?: ConversationHistoryWindow
}

/** Empty Conversation value used before a Session binding is available. */
export const EMPTY_CONVERSATION_SNAPSHOT: ConversationSnapshot = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}

/** Shell phase derived from Session lifecycle and registered target activity. */
export type ConversationPhase = 'blank' | 'engaging' | 'active'

/**
 * Resolve the shell phase without adding Conversation data to the Session snapshot.
 * @param session - current Session lifecycle state.
 * @param conversation - current target-neutral Conversation state.
 * @returns the phase used by the header, View ring, and composer layout.
 */
export function conversationPhase(
  session: SessionSnapshot,
  conversation: ConversationSnapshot,
): ConversationPhase {
  const active = conversation.activeTargets.size > 0
    || (session.historyAvailability === 'cached' && conversation.history?.firstSeq != null)
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  return active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
}
