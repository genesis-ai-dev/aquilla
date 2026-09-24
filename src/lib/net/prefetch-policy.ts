// When it is worth spending bandwidth on a preload (AQU-843).
//
// Prefetching reference text buys latency with bandwidth. For most translators
// that is a good trade — the pane is populated before they scroll into it. For
// the ones this feature exists for it can be the wrong trade: IBT's Caucasus
// and Dagestan teams work over metered, intermittent mobile links where the
// scarce resource is the request the translator is already waiting on, not the
// one they might want next.
//
// So preloads are opt-out by link quality, via the Network Information API
// hints the browser already gives us. Unsupported browsers (Safari, Firefox)
// report nothing and get the default: prefetch on.

export interface NetworkConditions {
  /** Data Saver / "reduce data usage" is on — an explicit user preference. */
  saveData?: boolean
  /** Round-trip-time bucket: "slow-2g" | "2g" | "3g" | "4g". */
  effectiveType?: string
}

/** Link buckets where a speculative fetch would starve the visible one. */
const TOO_SLOW_TO_SPECULATE = new Set(["slow-2g", "2g"])

/**
 * Whether speculative reference-text fetches are worth making on this link.
 *
 * Pure so the policy is testable without a browser: pass the conditions in.
 * `null`/`undefined` means the browser told us nothing — prefetch.
 */
export function shouldPrefetchReferences(conditions?: NetworkConditions | null): boolean {
  if (!conditions) return true
  if (conditions.saveData === true) return false
  if (conditions.effectiveType && TOO_SLOW_TO_SPECULATE.has(conditions.effectiveType)) {
    return false
  }
  return true
}

/** Read the live hints, tolerating the many environments that lack them. */
export function readNetworkConditions(): NetworkConditions | null {
  try {
    const conditions = (navigator as Navigator & { connection?: NetworkConditions }).connection
    return conditions ?? null
  } catch {
    return null
  }
}

/** `shouldPrefetchReferences` against the live link. Call per prefetch batch —
 *  conditions change mid-session, which is the whole point. */
export function referencePrefetchAllowed(): boolean {
  return shouldPrefetchReferences(readNetworkConditions())
}
