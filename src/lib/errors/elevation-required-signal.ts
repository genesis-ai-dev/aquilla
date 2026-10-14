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
 * the value works with useSyncExternalStore. Repeated raises while latched open
 * nothing new, so one dialog covers a burst of failing requests.
 */

const ELEVATION_REQUIRED_EVENT = "elevation-required"

const bus = new EventTarget()

/**
 * What the refused request was. The prompt words its "Verified" step from it:
 * - `action`: a membership/admin change. Nothing replays it, so the admin has
 *   to make it again.
 * - `sync-token`: a project sync-token mint (OPS-44). Held outbox edits resend
 *   on their own after the grant, and the project's pages reload their reads.
 */
export type ElevationReason = { kind: "action" } | { kind: "sync-token"; projectId: string }

/** Which kinds of refused work the open prompt covers. */
export type ElevationWaitingOn = "action" | "sync-token" | "both"

let elevationRequired = false
let actionWaiting = false
let syncTokenWaiting = false
// OPS-44: projects whose sync-token mint was refused since the last grant.
// Kept apart from the latch: closing the prompt unverified must not forget
// them, so a later step-up still reloads those projects' pages.
const refusedSyncTokenProjects = new Set<string>()

/**
 * Call from a fetch helper on a 403 whose body says "elevation required".
 * Defaults to an `action`. A raise while latched opens nothing new, but it
 * still records its reason, so a sync-token refusal that lands behind a
 * membership one is reloaded too, and the prompt's copy covers both.
 */
export function notifyElevationRequired(reason: ElevationReason = { kind: "action" }): void {
  if (reason.kind === "sync-token") refusedSyncTokenProjects.add(reason.projectId)
  const wasWaitingOn = getElevationWaitingOn()
  elevationRequired = true
  if (reason.kind === "action") actionWaiting = true
  else syncTokenWaiting = true
  if (getElevationWaitingOn() === wasWaitingOn) return
  bus.dispatchEvent(new Event(ELEVATION_REQUIRED_EVENT))
}

/** Reset the flag once the user closes the prompt. */
export function clearElevationRequired(): void {
  if (!elevationRequired) return
  elevationRequired = false
  actionWaiting = false
  syncTokenWaiting = false
  bus.dispatchEvent(new Event(ELEVATION_REQUIRED_EVENT))
}

/** Current latched state. */
export function isElevationRequired(): boolean {
  return elevationRequired
}

/** What the latched prompt is waiting on; null when it is not latched. */
export function getElevationWaitingOn(): ElevationWaitingOn | null {
  if (!elevationRequired) return null
  if (actionWaiting && syncTokenWaiting) return "both"
  return actionWaiting ? "action" : "sync-token"
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
 *
 * Listeners get the projects whose sync-token mint was refused since the last
 * grant; this call consumes that set.
 */
export function notifyElevationGranted(): void {
  const refused: ReadonlySet<string> = new Set(refusedSyncTokenProjects)
  refusedSyncTokenProjects.clear()
  bus.dispatchEvent(new CustomEvent<ReadonlySet<string>>(ELEVATION_GRANTED_EVENT, { detail: refused }))
}

/**
 * Subscribe to successful step-ups. The handler receives the projects whose
 * sync-token mint was refused before this grant. Returns an unsubscribe.
 */
export function onElevationGranted(
  handler: (refusedSyncTokenProjects: ReadonlySet<string>) => void,
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<ReadonlySet<string>>).detail ?? new Set())
  }
  bus.addEventListener(ELEVATION_GRANTED_EVENT, listener)
  return () => bus.removeEventListener(ELEVATION_GRANTED_EVENT, listener)
}
