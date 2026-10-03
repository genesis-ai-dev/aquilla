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
 * Every call goes through `@/lib/posthog`, which is consent-gated
 * (`opt_out_capturing_by_default`) — there is no capture path here that
 * bypasses that.
 */

import posthog from "@/lib/posthog"
import {
  AUDIO_ATTACHED,
  AUDIO_GENERATED,
  AUDIO_RECORDED,
  CELL_UNVALIDATED,
  CELL_VALIDATED,
} from "@/lib/event-names"

/** One event as it was handed to PostHog, for the dev log below. */
export interface CapturedTelemetryEvent {
  event: string
  properties: Record<string, unknown>
}

/** How many events the dev log keeps; old ones fall off the front. */
const DEV_LOG_LIMIT = 200

/**
 * A dev build has no PostHog key, so `posthog.capture` goes nowhere and these
 * events could not be checked by hand at all. In a dev build only, keep the
 * last few on `window.__aqTelemetry`: type it in the console after a click to
 * see exactly what would have been sent.
 */
function recordForDevtools(event: CapturedTelemetryEvent): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return
  const win = window as unknown as { __aqTelemetry?: CapturedTelemetryEvent[] }
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
function send(event: string, properties: Record<string, unknown>): void {
  try {
    recordForDevtools({ event, properties })
    posthog.capture(event, properties)
  } catch {
    /* dropped: a missing chart point, never a failed gesture */
  }
}

/** Which side of a cell the validation vote was cast on. */
export type ValidationMedium = "text" | "audio"

/**
 * Who performed the gesture. `ui` is a person in the SPA, `agent` the in-app
 * translation agent applying a draft review, `api` an external Agent-API
 * caller. The external surface is server-side (sync-worker) and does not run
 * this module today, so `api` is reserved for when that surface grows its own
 * reporting — it is in the union so a dashboard filter written now stays valid.
 */
export type TelemetrySource = "ui" | "agent" | "api"

/**
 * Where a clip came from. Only the originating gesture passes one; derived
 * re-attaches pass nothing and emit nothing (see `AUDIO_ATTACHED`).
 */
export type AudioOrigin = "attach" | "generate" | "record"

export interface CellValidationTelemetry {
  medium: ValidationMedium
  projectId: string
  fileId: string
  cellId: string
  /** The lane's tag. `''` (the default lane) is reported as `''`, not dropped. */
  lane?: string
  source?: TelemetrySource
}

/** Emit `cell validated` / `cell unvalidated` for one validation gesture. */
export function captureCellValidation(
  validated: boolean,
  t: CellValidationTelemetry,
): void {
  send(validated ? CELL_VALIDATED : CELL_UNVALIDATED, {
    medium: t.medium,
    project_id: t.projectId,
    file_id: t.fileId,
    cell_id: t.cellId,
    lane: t.lane ?? "",
    source: t.source ?? "ui",
  })
}

export interface AudioActionTelemetry {
  origin: AudioOrigin
  projectId: string
  fileId: string
  cellId: string
  /** The audio slot the clip landed in (`recording`, `generatedVoice`, a track id). */
  slot: string
  lane?: string
  source?: TelemetrySource
  /** Generation only: the voice the clip was synthesized with. */
  voiceId?: string
  /** Generation only: which synthesis backend produced it. */
  provider?: string
  durationMs?: number
}

const AUDIO_EVENT_FOR_ORIGIN: Record<AudioOrigin, string> = {
  attach: AUDIO_ATTACHED,
  generate: AUDIO_GENERATED,
  record: AUDIO_RECORDED,
}

/** Emit the `audio attached` / `audio generated` / `audio recorded` event. */
export function captureAudioAction(t: AudioActionTelemetry): void {
  send(AUDIO_EVENT_FOR_ORIGIN[t.origin], {
    project_id: t.projectId,
    file_id: t.fileId,
    cell_id: t.cellId,
    slot: t.slot,
    lane: t.lane ?? "",
    source: t.source ?? "ui",
    ...(t.voiceId !== undefined ? { voice_id: t.voiceId } : {}),
    ...(t.provider !== undefined ? { provider: t.provider } : {}),
    ...(t.durationMs !== undefined ? { duration_ms: Math.round(t.durationMs) } : {}),
  })
}
