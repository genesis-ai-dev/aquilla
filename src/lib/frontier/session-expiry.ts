/**
 * AQU-884 follow-up: the guard between fetch-layer 401s and the global
 * session-expired banner.
 *
 * A 401 may only raise the banner when the credential that failed is still the
 * credential the app holds. After a successful re-login, components whose React
 * state has not yet re-read the session store still fire requests carrying the
 * previous JWT for a few renders; those 401s land *after* `finalizeSession()`
 * lowered the banner and used to re-latch it on top of a healthy dashboard.
 *
 * The guard compares the failing JWT against the active session in IndexedDB —
 * the source of truth, immune to React state lag — so straggler failures from a
 * replaced credential are inert, while every genuine expiry still signals: the
 * stored session IS the expired one until the user re-authenticates. (A time- or
 * epoch-based guard can't distinguish these — the straggler requests *start*
 * after the re-login, they just carry the old credential.)
 */

import { loadActiveSession } from "./session-store"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"

/**
 * Raise the session-expired signal iff `failedJwt` is still the active
 * session's JWT. Call from fetch helpers on 401 with the JWT the failing
 * request actually used. Fire-and-forget safe (never rejects).
 */
export async function notifySessionExpiredIfCurrent(failedJwt: string): Promise<void> {
  try {
    const active = await loadActiveSession()
    if (active?.jwt !== failedJwt) return
  } catch {
    // Session store unreadable — staleness can't be proven. Prefer a
    // possibly-redundant banner over swallowing a genuine expiry.
  }
  notifySessionExpired()
}
