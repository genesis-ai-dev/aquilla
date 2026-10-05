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
 *    read as user-facing incidents. "Local" is the same rule that sets the
 *    `app_env` super-property (`analytics-env.ts`), so an exception is dropped
 *    exactly when its page would be tagged `app_env: "local"`. In particular
 *    the Tauri desktop shell, served from `tauri://localhost`, is an installed
 *    app and keeps its exceptions.
 *
 * Filtering in `before_send` is not enough for the ResizeObserver message on
 * its own: posthog-js rate-limits exception capture per exception TYPE before
 * `before_send` runs, so a burst of it spent the bucket real errors share.
 * `installResizeObserverNoiseGuard` stops it before PostHog's handler sees it.
 */

import { resolveAppEnv } from "@/lib/analytics-env"

/**
 * Both spellings the engines use. Chrome says "completed with undelivered
 * notifications", older Chrome and WebKit say "limit exceeded"; some wrappers
 * prefix the message with an error class, so this matches anywhere in the
 * string rather than anchoring at the start.
 */
const RESIZE_OBSERVER_NOISE = /ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The text of the exception that was actually raised: the flat
 * `$exception_message` older SDKs send, and the FIRST entry of the structured
 * `$exception_list`. posthog-js puts the thrown value first and its `cause`
 * chain after it, and a cause is context: a real error whose cause happens to
 * be a ResizeObserver message is still a real error, and is kept.
 */
function exceptionMessages(properties: Record<string, unknown>): string[] {
  const out: string[] = []
  const flat = properties.$exception_message
  if (typeof flat === "string") out.push(flat)
  const list = properties.$exception_list
  const raised = Array.isArray(list) ? list[0] : undefined
  if (isRecord(raised)) {
    if (typeof raised.value === "string") out.push(raised.value)
    if (typeof raised.type === "string") out.push(raised.type)
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
    return resolveAppEnv(new URL(url)) === "local"
  } catch {
    return false
  }
}

/**
 * Stop the ResizeObserver loop message before PostHog's error handler sees it.
 *
 * Dropping it in `before_send` (below) is not enough on its own. posthog-js
 * rate-limits exception capture per exception TYPE before `before_send` runs,
 * and this message arrives as a plain "Error", the same bucket as most real
 * failures. A burst of it (one resizable pane can raise dozens) spent the
 * bucket, and the next real Error was skipped as rate-limited, never reaching
 * PostHog at all (browser pass, 2026-10-02: 25 warnings, then a real Error,
 * 0 sent).
 *
 * A capturing listener on window runs ahead of the `window.onerror` handler
 * posthog-js installs, so stopping propagation here keeps the message out of
 * its counter. Every other error passes untouched. Install it before
 * `posthog.init`.
 */
export function installResizeObserverNoiseGuard(target: Window): void {
  target.addEventListener(
    "error",
    (event: ErrorEvent) => {
      if (typeof event.message === "string" && RESIZE_OBSERVER_NOISE.test(event.message)) {
        event.stopImmediatePropagation()
      }
    },
    { capture: true },
  )
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
