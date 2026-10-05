/**
 * AQU-1572: drop the `$exception` events that are not signal.
 *
 * Checked on 2026-10-02: the last three hours of exceptions were 38 copies of
 * one benign browser message ("ResizeObserver loop completed with undelivered
 * notifications"), captured from prod, dev AND localhost into the same project.
 * A real editor error arriving in that stream is invisible, which is the whole
 * reason the exception feed is worth having.
 *
 * Two filters, both `$exception`-only — ordinary analytics events are never
 * dropped, including from localhost, because the funnel work depends on being
 * able to exercise it locally:
 *
 * 1. **ResizeObserver loop messages.** A spec-defined notification that the
 *    browser emits when a resize handler itself causes a resize; it reaches
 *    `window.onerror` with no stack and nothing actionable. The browser, not
 *    this app, decides to report it, so it has to be filtered on the way out.
 * 2. **Localhost builds.** A developer's own machine shares the production
 *    PostHog key, so local crashes land in the production exception feed and
 *    read as user-facing incidents.
 */

/**
 * Both spellings the engines use. Chrome says "completed with undelivered
 * notifications", older Chrome and WebKit say "limit exceeded"; some wrappers
 * prefix the message with an error class, so this matches anywhere in the
 * string rather than anchoring at the start.
 */
const RESIZE_OBSERVER_NOISE = /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i

/** Hostnames that mean "this is somebody's dev machine, not a deployment". */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Every place PostHog may put the exception text: the flat `$exception_message`
 * and each entry of the structured `$exception_list`.
 */
function exceptionMessages(properties: Record<string, unknown>): string[] {
  const out: string[] = []
  const flat = properties.$exception_message
  if (typeof flat === "string") out.push(flat)
  const list = properties.$exception_list
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isRecord(entry)) continue
      if (typeof entry.value === "string") out.push(entry.value)
      if (typeof entry.type === "string") out.push(entry.type)
    }
  }
  return out
}

/** Is this exception the benign ResizeObserver loop notification? */
export function isResizeObserverNoise(properties: Record<string, unknown>): boolean {
  return exceptionMessages(properties).some((m) => RESIZE_OBSERVER_NOISE.test(m))
}

/** Did this event come from a dev machine rather than a deployed origin? */
export function isLocalhostOrigin(properties: Record<string, unknown>): boolean {
  const url = properties.$current_url
  if (typeof url !== "string" || !url) return false
  try {
    return LOCAL_HOSTNAMES.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** The shape `before_send` hands us — structural, so this module needs no posthog import. */
export interface NoiseFilterableEvent {
  event: string
  properties?: Record<string, unknown>
}

/**
 * Should this captured event be dropped instead of sent? Only ever true for
 * `$exception`; returning `true` from here makes `before_send` return `null`.
 */
export function shouldDropCaptureEvent(event: NoiseFilterableEvent | null): boolean {
  if (!event || event.event !== "$exception") return false
  const properties = event.properties ?? {}
  return isResizeObserverNoise(properties) || isLocalhostOrigin(properties)
}
