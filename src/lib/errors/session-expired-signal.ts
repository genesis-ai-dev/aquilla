/**
 * AQU-293: lightweight session-expiry signal.
 *
 * When an authenticated request rejects the active JWT, the guarded notifier
 * latches that credential. The top-level banner subscribes so helpers stay
 * decoupled from the UI tree.
 *
 * Design:
 *  - Pure module-level EventTarget: zero deps, no React context required.
 *  - **Latched state, not a transient event (AQU-884).** The module holds the
 *    expired flag; subscribers are told the current value on every change and
 *    can read it at mount via `isSessionExpired()`. That matters at boot: the
 *    401 often lands before the banner mounts (or while the app is mid-redirect
 *    from `/` to `/orgs/all`), and a transient event would be missed entirely.
 *  - The flag stays set until the user dismisses the banner or re-authenticates
 *    — `clearSessionExpired()` is the only way down. Navigation does not clear
 *    it; `finalizeSession()` calls it on every successful auth.
 *  - Fetch helpers should not call `notifySessionExpired(jwt)` directly: use
 *    `notifySessionExpiredIfCurrent(failedJwt)` from lib/frontier/session-expiry,
 *    which drops 401s from a credential that re-login has since replaced. This
 *    module stays dependency-free; the guard lives there.
 */

const SESSION_EXPIRED_EVENT = "session-expired"

/** Module-level bus — stable across re-renders. */
const bus = new EventTarget()

/** JWT whose rejection is latched until dismiss / re-auth. */
let expiredJwt: string | null = null

/** Call from any fetch helper on 401 / UserError(session-expired). */
export function notifySessionExpired(jwt: string): void {
  expiredJwt = jwt
  bus.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

/**
 * Reset the flag — the user dismissed the banner, or re-authenticated
 * successfully (see `finalizeSession` in lib/frontier/auth.ts).
 */
export function clearSessionExpired(): void {
  if (expiredJwt === null) return
  expiredJwt = null
  bus.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

/** Rejected credential currently latched, or null. */
export function getExpiredSessionJwt(): string | null {
  return expiredJwt
}

/** Current latched state, optionally scoped to an active credential. */
export function isSessionExpired(jwt?: string | null): boolean {
  return expiredJwt !== null && (jwt === undefined || expiredJwt === jwt)
}

/**
 * Subscribe to session-expired changes. The handler receives the rejected JWT
 * or null, so it doubles as a "cleared" notification. Returns an unsubscribe.
 */
export function onSessionExpired(handler: (jwt: string | null) => void): () => void {
  const listener = () => handler(expiredJwt)
  bus.addEventListener(SESSION_EXPIRED_EVENT, listener)
  return () => bus.removeEventListener(SESSION_EXPIRED_EVENT, listener)
}
