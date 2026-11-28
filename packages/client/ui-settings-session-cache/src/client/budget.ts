/** Numeric settings validation shared by the budget reader and the form. */

import type { SessionHistoryCacheBudget } from '@deepseek-ai/dsh-api-session-controller/client'

/** Largest integer MiB amount representable as a safe integer byte count. */
export const MAX_CACHE_MIB = Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))

/** Check whether a setting is a positive integer MiB amount.
 * @param value Candidate amount from Settings or staged form text.
 * @returns Whether the amount fits the Core cache's byte accounting range.
 */
export function isCacheMiB(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_CACHE_MIB
}

/** Extract both amounts from a Host settings value.
 * @param value Effective value published by the shared Settings form.
 * @returns A complete budget when both fields pass runtime validation.
 */
export function readBudget(value: unknown): SessionHistoryCacheBudget | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('historyCacheSessionMiB' in value) || !('historyCachePageMiB' in value)) return undefined
  const { historyCacheSessionMiB, historyCachePageMiB } = value
  if (!isCacheMiB(historyCacheSessionMiB) || !isCacheMiB(historyCachePageMiB)) return undefined
  return { historyCacheSessionMiB, historyCachePageMiB }
}
