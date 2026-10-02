/**
 * AQU-1572: the properties of the validation and audio events, as plain data.
 *
 * Shared by the browser (`review-telemetry.ts`, which sends them) and the
 * sync-worker (which sends the Agent API's), so a validation reads the same in
 * PostHog whoever made it. No PostHog import here: the worker cannot load
 * posthog-js, and a pure builder is testable without one.
 *
 * Data policy: ids and counts only. No cell text, transcript, file name, voice
 * name or URL ever goes into these. A cell id is sent only when it is an
 * opaque UUID: a Bible project's cell ids are verse references, and which
 * passage a team is working on is exactly what the session-replay masking in
 * `posthog.ts` exists to hide.
 */
import {
  AUDIO_ATTACHED,
  AUDIO_GENERATED,
  AUDIO_RECORDED,
  CELL_UNVALIDATED,
  CELL_VALIDATED,
} from "./event-names"
import { looksLikeUuid } from "./uuid"

/** Who acted: a person in the app, the agent, or an API caller. */
export type TelemetrySource = "ui" | "agent" | "api"

/** Which approval changed. A cell's text and its audio are approved apart. */
export type ValidationMedium = "text" | "audio"

export type TelemetryProps = Record<string, string | number | boolean>

export interface TelemetryEvent {
  event: string
  properties: TelemetryProps
}

/** The cell id when it is opaque, otherwise nothing (see the data policy). */
export function telemetryCellId(cellId: string | null | undefined): string | undefined {
  return cellId && looksLikeUuid(cellId) ? cellId : undefined
}

/** A lane's tag, with the default lane (`''`) spelled out so it can be filtered on. */
export function telemetryLane(lane: string | null | undefined): string {
  return lane ? lane : "default"
}

interface CellsTarget {
  projectId: string
  /** Every cell the action touched, as `{ fileId, cellId }`. */
  cells: ReadonlyArray<{ fileId: string; cellId: string }>
  lane?: string | null
  source: TelemetrySource
  /** Where it happened, for the UI: "cell", "selection", "batch", "agent-pane"… */
  surface?: string
}

/**
 * The shared part: project, lane, how many cells, and — when there is exactly
 * one file or one cell — which. A bulk action across files names neither.
 */
function cellsProps({ projectId, cells, lane, source, surface }: CellsTarget): TelemetryProps {
  const props: TelemetryProps = {
    project_id: projectId,
    lane: telemetryLane(lane),
    source,
    cell_count: cells.length,
  }
  if (surface) props.surface = surface
  const files = new Set(cells.map((c) => c.fileId))
  if (files.size === 1) props.file_id = cells[0].fileId
  if (files.size > 1) props.file_count = files.size
  if (cells.length === 1) {
    const id = telemetryCellId(cells[0].cellId)
    if (id) props.cell_id = id
  }
  return props
}

export interface ValidationEventInput extends CellsTarget {
  medium: ValidationMedium
  validated: boolean
}

/** `cell validated` / `cell unvalidated`, or null when no cell changed. */
export function validationEvent(input: ValidationEventInput): TelemetryEvent | null {
  if (input.cells.length === 0) return null
  return {
    event: input.validated ? CELL_VALIDATED : CELL_UNVALIDATED,
    properties: { ...cellsProps(input), medium: input.medium },
  }
}

export interface AudioAttachedInput extends CellsTarget {
  /** How the file arrived: "upload" from the app, "link" from LinkMedia. */
  method: "upload" | "link"
  durationMs?: number | null
}

export function audioAttachedEvent(input: AudioAttachedInput): TelemetryEvent | null {
  if (input.cells.length === 0) return null
  return {
    event: AUDIO_ATTACHED,
    properties: {
      ...cellsProps(input),
      method: input.method,
      ...durationProp(input.durationMs),
    },
  }
}

export interface AudioRecordedInput extends CellsTarget {
  durationMs?: number | null
  /** The take was validated on save, under the recorder's own rule. */
  autoValidated: boolean
}

export function audioRecordedEvent(input: AudioRecordedInput): TelemetryEvent | null {
  if (input.cells.length === 0) return null
  return {
    event: AUDIO_RECORDED,
    properties: {
      ...cellsProps(input),
      auto_validated: input.autoValidated,
      ...durationProp(input.durationMs),
    },
  }
}

export interface AudioGeneratedInput extends CellsTarget {
  /** The voice provider: "inworld", "elevenlabs", … */
  provider: string
  /** A stock voice's id. A cloned voice is somebody's voice, so its id is
   *  never sent; `voice_kind` says it was a clone. */
  voiceId?: string | null
  voiceKind: "stock" | "clone"
  durationMs?: number | null
}

export function audioGeneratedEvent(input: AudioGeneratedInput): TelemetryEvent | null {
  if (input.cells.length === 0) return null
  return {
    event: AUDIO_GENERATED,
    properties: {
      ...cellsProps(input),
      provider: input.provider,
      voice_kind: input.voiceKind,
      ...(input.voiceKind === "stock" && input.voiceId ? { voice_id: input.voiceId } : {}),
      ...durationProp(input.durationMs),
    },
  }
}

function durationProp(ms: number | null | undefined): TelemetryProps {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? { duration_ms: Math.round(ms) } : {}
}
