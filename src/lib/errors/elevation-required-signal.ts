/**
 * AQU-1322: latched "admin step-up needed" signal.
 *
 * A platform admin who acts on an org or project they do not belong to gets an
 * HTTP 403 whose error starts "elevation required" until they finish the
 * emailed-code step-up. Fetch helpers raise this signal once; the global
 * AdminElevationPrompt subscribes and opens the verify dialog.
 *
 * Same shape as session-expired-signal: a module-level EventTarget holding a
 * latched flag, so a 403 that lands before the prompt mounts is not lost and
 * the value works with useSyncExternalStore. Repeated raises while latched are
 * no-ops, so one dialog covers a burst of failing requests.
 */

const ELEVATION_REQUIRED_EVENT = "elevation-required"

const bus = new EventTarget()

let elevationRequired = false

/** Call from a fetch helper on a 403 whose body says "elevation required". */
export function notifyElevationRequired(): void {
  if (elevationRequired) return
  elevationRequired = true
  bus.dispatchEvent(new Event(ELEVATION_REQUIRED_EVENT))
}

/** Reset the flag once the user closes the prompt. */
export function clearElevationRequired(): void {
  if (!elevationRequired) return
  elevationRequired = false
  bus.dispatchEvent(new Event(ELEVATION_REQUIRED_EVENT))
}

/** Current latched state. */
export function isElevationRequired(): boolean {
  return elevationRequired
}

/** Subscribe to changes. The handler receives the current state. Returns an unsubscribe. */
export function onElevationRequired(handler: (required: boolean) => void): () => void {
  const listener = () => handler(elevationRequired)
  bus.addEventListener(ELEVATION_REQUIRED_EVENT, listener)
  return () => bus.removeEventListener(ELEVATION_REQUIRED_EVENT, listener)
}

const ELEVATION_GRANTED_EVENT = "elevation-granted"

/**
 * OPS-44: call once the emailed code verifies. Unlike the required signal this
 * is a plain event, not a latch: work that was waiting on elevation (the outbox
 * holds a project whose sync-token mint answered "elevation required") retries
 * when it hears it, and a listener that mounts later has nothing to catch up on.
 */
export function notifyElevationGranted(): void {
  bus.dispatchEvent(new Event(ELEVATION_GRANTED_EVENT))
}

/** Subscribe to successful step-ups. Returns an unsubscribe. */
export function onElevationGranted(handler: () => void): () => void {
  bus.addEventListener(ELEVATION_GRANTED_EVENT, handler)
  return () => bus.removeEventListener(ELEVATION_GRANTED_EVENT, handler)
}
