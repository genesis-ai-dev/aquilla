/**
 * AQU-1572: per-gesture telemetry for cell validation and the audio actions.
 *
 * Lives beside the emit seam rather than in the ~40 components that can reach
 * these gestures: `src/lib/sync/events-emit.ts` is the one place every
 * validation and every clip attach already funnels through, so instrumenting
 * there is what makes "one gesture, one event" true by construction instead of
 * by every call site remembering. Same reasoning as the AQU-267 funnel events
 * that already sit on that seam.
 *
 * The events themselves are built by `review-events.ts`, which the sync-worker
 * shares for the Agent API's events, so both senders agree on every name.
 *
 * Every call goes through `@/lib/posthog`, which is consent-gated
 * (`opt_out_capturing_by_default`) — there is no capture path here that
 * bypasses that.
 */

import posthog from "@/lib/posthog"
import {
  audioActionEvent,
  cellValidationEvent,
  type AudioActionTelemetry,
  type CellValidationTelemetry,
  type TelemetryEvent,
} from "@/lib/review-events"

export type {
  AudioActionTelemetry,
  AudioOrigin,
  CellValidationTelemetry,
  TelemetrySource,
  TelemetrySurface,
  ValidationMedium,
} from "@/lib/review-events"

/** How many events the dev log keeps; old ones fall off the front. */
const DEV_LOG_LIMIT = 200

/**
 * A dev build has no PostHog key, so `posthog.capture` goes nowhere and these
 * events could not be checked by hand at all. In a dev build only, keep the
 * last few on `window.__aqTelemetry`: type it in the console after a click to
 * see exactly what would have been sent.
 */
function recordForDevtools(event: TelemetryEvent): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return
  const win = window as unknown as { __aqTelemetry?: TelemetryEvent[] }
  const log = win.__aqTelemetry ?? (win.__aqTelemetry = [])
  log.push(event)
  if (log.length > DEV_LOG_LIMIT) log.splice(0, log.length - DEV_LOG_LIMIT)
}

/**
 * Every capture in this module goes through here. These run AFTER the write
 * reached the outbox, inside the emit function, so a capture that threw would
 * reject an emit whose write had in fact landed, and the caller would show an
 * error for a validation that happened. Telemetry never gets to break the
 * action it describes.
 */
function send(build: () => TelemetryEvent): void {
  try {
    const event = build()
    recordForDevtools(event)
    posthog.capture(event.event, event.properties)
  } catch {
    /* dropped: a missing chart point, never a failed gesture */
  }
}

/** Emit `cell validated` / `cell unvalidated` for one validation gesture. */
export function captureCellValidation(
  validated: boolean,
  t: CellValidationTelemetry,
): void {
  send(() => cellValidationEvent(validated, t))
}

/** Emit the `audio attached` / `audio generated` / `audio recorded` event. */
export function captureAudioAction(t: AudioActionTelemetry): void {
  send(() => audioActionEvent(t))
}
