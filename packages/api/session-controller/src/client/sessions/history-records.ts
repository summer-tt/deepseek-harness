/** Client range access and type narrowing for aligned Session history records. */

import type {
  SessionHistoryRecord,
} from '../../types.ts'
import type { SessionLiveEventEntry } from '../contract/events.ts'

/**
 * Narrow aligned wire records to their Client event types without allocation.
 * @param records - validated history transport records.
 * @returns the same record array with typed inner events.
 */
export function historyEntries(
  records: readonly SessionHistoryRecord[],
): readonly SessionLiveEventEntry[] {
  return records as unknown as readonly SessionLiveEventEntry[]
}

/**
 * Read the first logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive first Session sequence.
 */
export function historyRecordFirstSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}

/**
 * Read the final logical sequence represented by one wire record.
 * @param record - validated Session event.
 * @returns inclusive final Session sequence.
 */
export function historyRecordLastSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}

/**
 * Compare validated history values without relying on property order or the prototype chain.
 * @param left - an accepted record or header.
 * @param right - the candidate record or header.
 * @returns whether the values have the same JSON content.
 */
export function sameHistoryValue(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]]
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [a, b] = pair
    if (a === b) continue
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    for (const key of keys) {
      if (!Object.hasOwn(b, key)) return false
      pending.push([Reflect.get(a, key), Reflect.get(b, key)])
    }
  }
  return true
}
