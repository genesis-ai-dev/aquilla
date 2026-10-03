/**
 * AQU-1572: the validation and audio events, as plain data.
 *
 * One builder, two senders:
 * - the browser, through `cell-telemetry.ts`, at the emit seam in
 *   `sync/events-emit.ts` (every validation and every clip attach a person
 *   makes in the app passes through there);
 * - the sync-worker, for what the Agent API commits
 *   (`sync-worker/src/external/review-telemetry.ts`), which no browser sees.
 *
 * Both build their events here, so a validation reads the same in PostHog
 * whoever made it: the same event names, the same property names, the same
 * values for the same facts. No PostHog import: the worker cannot load
 * posthog-js, and a pure builder is testable without one.
 *
 * One event per line. A bulk run of forty lines is forty events; `surface`
 * says they came from a selection or a batch rather than forty clicks.
 *
 * Data policy: ids only. No cell text, transcript, file name, voice name or
 * URL ever goes into these. A cell id is sent only when it is an opaque UUID:
 * a Bible project's cell ids are verse references ("MAT 1:1"), and which
 * passage a team is working on is exactly what the session-replay masking in
 * `posthog.ts` exists to hide (OPS-3). Such a line still reports its file.
 */
import {
  AUDIO_ATTACHED,
  AUDIO_GENERATED,
  AUDIO_RECORDED,
  CELL_UNVALIDATED,
  CELL_VALIDATED,
} from "./event-names"
import { looksLikeUuid } from "./uuid"

/** Which side of a cell the validation vote was cast on. */
export type ValidationMedium = "text" | "audio"

/**
 * Who performed the gesture. `ui` is a person in the SPA, `agent` the in-app
 * translation agent (a draft review or proposal it prepared, or an Agent API
 * commit over MCP or the in-app session route), `api` any other Agent API
 * caller holding a token, which cannot be told apart from an agent.
 */
export type TelemetrySource = "ui" | "agent" | "api"

/**
 * Where a clip came from. Only the originating gesture passes one; derived
 * re-attaches pass nothing and emit nothing (see `AUDIO_ATTACHED`).
 */
export type AudioOrigin = "attach" | "generate" | "record"

/**
 * Where in the app the gesture was made, so one line validated from its own
 * row reads apart from forty validated by a selection or a batch. Optional:
 * a path that has not said where it is simply sends no `surface`.
 *
 * - `cell` the line's own control in the editor row (or its TTS button)
 * - `selection` the selection bar's bulk actions
 * - `batch` the workspace's "Batch validate" actions for the open file
 * - `agent-pane` the agent pane's target editor and validation control
 * - `proposal` an agent proposal or prepared-validation queue, confirmed
 * - `draft-review` accepting the agent's draft review of a line
 * - `recorder` the recording modal (save, upload, generate, takes strip)
 * - `recording-tab` the cell's Recording tab
 * - `voice-panel` the cell's voice panel
 * - `voice-together` the selection's "Voice together"
 * - `generate-all` the file's "Generate all" voice run
 * - `timeline` a file or link dropped onto the timeline
 * - `api` the Agent API, reported by the sync-worker
 */
export type TelemetrySurface =
  | "cell"
  | "selection"
  | "batch"
  | "agent-pane"
  | "proposal"
  | "draft-review"
  | "recorder"
  | "recording-tab"
  | "voice-panel"
  | "voice-together"
  | "generate-all"
  | "timeline"
  | "api"

export type TelemetryProps = Record<string, string | number | boolean>

export interface TelemetryEvent {
  event: string
  properties: TelemetryProps
}

/** The cell id when it is opaque, otherwise nothing (see the data policy). */
export function telemetryCellId(cellId: string | null | undefined): string | undefined {
  return cellId && looksLikeUuid(cellId) ? cellId : undefined
}

/**
 * Every property a `cell validated` / `cell unvalidated` may carry, from
 * either sender. The browser and the worker are both tested against this
 * list, so neither can rename or add one without the other noticing.
 */
export const VALIDATION_EVENT_PROPERTIES = [
  "medium", "project_id", "file_id", "cell_id", "lane", "source", "auto", "surface",
] as const

/** The same for `audio attached` / `audio generated` / `audio recorded`. */
export const AUDIO_EVENT_PROPERTIES = [
  "project_id", "file_id", "cell_id", "slot", "lane", "source", "surface",
  "voice_id", "provider", "duration_ms",
] as const

export interface CellValidationTelemetry {
  medium: ValidationMedium
  projectId: string
  fileId: string
  cellId: string
  /** The lane's tag. `''` (the default lane) is reported as `''`, not dropped. */
  lane?: string
  source?: TelemetrySource
  /**
   * The app cast this vote by itself (your own edit, your own fresh take)
   * rather than a person asking for it. Sent as `auto`, always present, so a
   * filter on `auto = false` keeps exactly the deliberate reviews.
   */
  auto?: boolean
  surface?: TelemetrySurface
}

/** `cell validated` / `cell unvalidated` for one line. */
export function cellValidationEvent(validated: boolean, t: CellValidationTelemetry): TelemetryEvent {
  const cellId = telemetryCellId(t.cellId)
  return {
    event: validated ? CELL_VALIDATED : CELL_UNVALIDATED,
    properties: {
      medium: t.medium,
      project_id: t.projectId,
      file_id: t.fileId,
      ...(cellId ? { cell_id: cellId } : {}),
      lane: t.lane ?? "",
      source: t.source ?? "ui",
      auto: t.auto ?? false,
      ...(t.surface ? { surface: t.surface } : {}),
    },
  }
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
  surface?: TelemetrySurface
  /** Generation only: the voice the clip was synthesized with (the project's voice record id). */
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

/** `audio attached` / `audio generated` / `audio recorded` for one line. */
export function audioActionEvent(t: AudioActionTelemetry): TelemetryEvent {
  const cellId = telemetryCellId(t.cellId)
  return {
    event: AUDIO_EVENT_FOR_ORIGIN[t.origin],
    properties: {
      project_id: t.projectId,
      file_id: t.fileId,
      ...(cellId ? { cell_id: cellId } : {}),
      slot: t.slot,
      lane: t.lane ?? "",
      source: t.source ?? "ui",
      ...(t.surface ? { surface: t.surface } : {}),
      ...(t.voiceId !== undefined ? { voice_id: t.voiceId } : {}),
      ...(t.provider !== undefined ? { provider: t.provider } : {}),
      ...(t.durationMs !== undefined && Number.isFinite(t.durationMs)
        ? { duration_ms: Math.round(t.durationMs) }
        : {}),
    },
  }
}
