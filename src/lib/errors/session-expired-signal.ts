/**
 * FRO-293: lightweight session-expiry signal.
 *
 * When any fetch helper throws UserError(401 / session-expired), it calls
 * `notifySessionExpired()`. A React hook (`useSessionExpired`) subscribes to
 * these notifications so the top-level banner can react without tight coupling
 * between helpers and the UI tree.
 *
 * Design:
 *  - Pure module-level EventTarget: zero deps, no React context required.
 *  - One-shot per expiry event: the banner renders once and stays until the
 *    user dismisses or navigates to /login. It does NOT re-fire on repeated
 *    401s from the same expired session.
 *  - `clearSessionExpired()` lets the login page reset the flag on success.
 */

const SESSION_EXPIRED_EVENT = "session-expired"

/** Module-level bus — stable across re-renders. */
const bus = new EventTarget()

/** Call from any fetch helper on 401 / UserError(session-expired). */
export function notifySessionExpired(): void {
  bus.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}

/** Subscribe to session-expired events. Returns an unsubscribe function. */
export function onSessionExpired(handler: () => void): () => void {
  bus.addEventListener(SESSION_EXPIRED_EVENT, handler)
  return () => bus.removeEventListener(SESSION_EXPIRED_EVENT, handler)
}
