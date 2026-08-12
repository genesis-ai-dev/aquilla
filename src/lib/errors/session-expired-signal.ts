/**
 * AQU-293: lightweight session-expiry signal.
 *
 * When any fetch helper throws UserError(401 / session-expired), it calls
 * `notifySessionExpired()`. The top-level banner subscribes so helpers stay
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
 */

const SESSION_EXPIRED_EVENT = "session-expired"

/** Module-level bus — stable across re-renders. */
const bus = new EventTarget()

/** Latched flag: true from the first 401 until dismiss / re-auth. */
let expired = false

/** Call from any fetch helper on 401 / UserError(session-expired). */
export function notifySessionExpired(): void {
  expired = true
  bus.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

/**
 * Reset the flag — the user dismissed the banner, or re-authenticated
 * successfully (see `finalizeSession` in lib/frontier/auth.ts).
 */
export function clearSessionExpired(): void {
  if (!expired) return
  expired = false
  bus.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

/** Current latched state — read this at mount, before any event arrives. */
export function isSessionExpired(): boolean {
  return expired
}

/**
 * Subscribe to session-expired changes. The handler receives the current
 * value, so it doubles as a "cleared" notification. Returns an unsubscribe
 * function.
 */
export function onSessionExpired(handler: (expired: boolean) => void): () => void {
  const listener = () => handler(expired)
  bus.addEventListener(SESSION_EXPIRED_EVENT, listener)
  return () => bus.removeEventListener(SESSION_EXPIRED_EVENT, listener)
}
