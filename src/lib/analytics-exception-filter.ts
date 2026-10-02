/**
 * `$exception` events that are noise, dropped before they leave the browser
 * (AQU-1572).
 *
 * Two sources made up nearly all of the exception stream:
 *
 * 1. "ResizeObserver loop completed with undelivered notifications." The
 *    browser reports it as a window `error` whenever a ResizeObserver callback
 *    changes layout that the same frame then has to measure again. Nothing
 *    threw and nothing is lost — the remaining notifications arrive next frame
 *    — but every resizable pane, virtualised list and auto-growing textarea in
 *    the editor can trigger it, so it buried the real failures. Older Chromium
 *    words it "ResizeObserver loop limit exceeded".
 * 2. Exceptions from a localhost build. The same PostHog key is baked into
 *    every build, so a dev server's crashes landed in the production project
 *    beside real users'. Which hosts count as local, and why the desktop shell
 *    (which also looks like localhost) does not, lives in `analytics-env.ts`.
 *
 * Every other exception, and every non-exception event, passes through
 * untouched. `posthog.ts` runs this ahead of `redactCaptureEvent`, so redaction
 * still sees everything that survives.
 */
import { resolveAppEnv } from "@/lib/analytics-env"

export const EXCEPTION_EVENT = "$exception"

/** Both browser wordings; matched anywhere so an "Uncaught " prefix still counts. */
const RESIZE_OBSERVER_LOOP =
  /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/i

export function isResizeObserverLoopMessage(message: unknown): boolean {
  return typeof message === "string" && RESIZE_OBSERVER_LOOP.test(message)
}

/**
 * Stop the ResizeObserver loop warning before PostHog's error handler sees it.
 *
 * Dropping it in `before_send` is not enough on its own. posthog-js rate-limits
 * exception capture per exception TYPE before `before_send` runs, and this
 * warning is a plain "Error" — the same bucket as most real failures. A burst
 * of it (one resizable pane can raise dozens) spent the bucket and the next
 * real Error was skipped as rate-limited, never reaching PostHog at all
 * (browser pass, 2026-10-02: 25 warnings, then a real Error → 0 sent).
 *
 * A capturing listener on window runs ahead of the `window.onerror` handler
 * posthog-js installs, so stopping propagation here keeps the warning out of
 * its counter. Every other error passes untouched. Install it before
 * `posthog.init`.
 */
export function installResizeObserverNoiseGuard(target: Window): void {
  target.addEventListener(
    "error",
    (event: ErrorEvent) => {
      if (isResizeObserverLoopMessage(event.message)) event.stopImmediatePropagation()
    },
    { capture: true },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * The message of the exception that was actually raised. posthog-js builds
 * `$exception_list` with the thrown value first and its `cause` chain after
 * it, each entry `{ type, value, mechanism, stacktrace }`; for a window
 * `error` with no Error object (which is how ResizeObserver reports) `value`
 * is the event's message. `$exception_message` is the flat field older SDKs
 * sent, read as a fallback.
 */
function topLevelExceptionMessages(properties: Record<string, unknown>): unknown[] {
  const list = properties.$exception_list
  const first = Array.isArray(list) && isRecord(list[0]) ? list[0].value : undefined
  return [first, properties.$exception_message]
}

/** Was this event captured on a page served by a local build? */
function capturedOnLocalBuild(properties: Record<string, unknown>): boolean {
  const url = properties.$current_url
  if (typeof url !== "string" || !url) return false
  try {
    return resolveAppEnv(new URL(url)) === "local"
  } catch {
    return false
  }
}

/** The shape `before_send` hands us — structural, so this module needs no posthog import. */
export interface FilterableCaptureEvent {
  event: string
  properties?: Record<string, unknown>
}

/**
 * `before_send` hook: return `null` (drop) for a ResizeObserver-loop
 * `$exception` or an `$exception` captured on a localhost build; return every
 * other event as it came in.
 */
export function dropNoisyExceptions<T extends FilterableCaptureEvent>(event: T | null): T | null {
  if (!event || event.event !== EXCEPTION_EVENT) return event
  const properties = event.properties ?? {}
  if (topLevelExceptionMessages(properties).some(isResizeObserverLoopMessage)) return null
  if (capturedOnLocalBuild(properties)) return null
  return event
}
