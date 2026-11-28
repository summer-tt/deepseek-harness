/** Budget fields shared by the Host schema and the Client history cache. */

/** Page-local inactive Session history budget in whole MiB. */
export interface SessionHistoryCacheBudget {
  /** Maximum weight of one inactive Session entry, including its reading positions. */
  readonly historyCacheSessionMiB: number
  /** Maximum combined weight of inactive Session entries on one page. */
  readonly historyCachePageMiB: number
}

/** Byte multiplier for the public budget unit. */
export const BYTES_PER_MIB = 1024 * 1024

/** Largest whole MiB budget whose byte count is a safe integer. */
export const MAX_HISTORY_CACHE_MIB = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MIB)

/** Initial cache limits before a Client receives Settings. */
export const DEFAULT_HISTORY_CACHE_BUDGET: SessionHistoryCacheBudget = {
  historyCacheSessionMiB: 20,
  historyCachePageMiB: 200,
}
