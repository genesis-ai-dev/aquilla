// Wire serialiser for one `cells` projection row.
//
// Shared by the by-ids read path (GET …/files/:f/cells?cellIds=) and the
// POST /events fan-out, which inlines a committed cell's CURRENT projected
// rows onto its `event.applied` frame so clients can apply them without a
// follow-up refetch. Both surfaces MUST emit byte-identical rows — the
// client stores whichever arrives without distinguishing the source.
//
// The column list, raw row shape, and `mapCellRow` mirror cells-read-route.ts
// exactly. SWARM-TODO(orchestrator): cells-read-route.ts still carries its
// own private copy of these (`columns`, `CellRowRaw`, `CellRowOut`, `mapRow`)
// — replace them with imports from this module (pure move; the by-ids
// byte-identity test in events-route.test.ts guards against drift meanwhile).

import type { AiDraftProvenance } from "./types"

/** Projection columns read for every cell row, in wire order. */
export const CELL_ROW_COLUMNS =
  "cell_id, side, target_lang, value, value_html, type, canonical_ref, anchor_cell_id, " +
  "event_id, source_event_id, last_editor, last_edit_at, validated, ai_drafted, ai_draft, word_count, " +
  "endorsement_count, start_ms, end_ms, " +
  "medium, sequence_index, transcription, camera_state, metadata, lane_id"

export interface CellRowRaw {
  cell_id: string
  side: "source" | "target"
  /** AQU-538: target-language lane. '' = default lane; always '' on source rows. */
  target_lang: string
  value: string
  value_html: string | null
  type: string | null
  canonical_ref: string | null
  anchor_cell_id: string | null
  event_id: string
  source_event_id: string | null
  last_editor: string | null
  last_edit_at: number
  validated: number
  ai_drafted: number
  ai_draft: AiDraftProvenance | string | null
  word_count: number
  endorsement_count: number
  start_ms: number | null
  end_ms: number | null
  medium: string | null
  sequence_index: number | null
  transcription: string | null
  camera_state: string | null
  /** JSONB — the driver hands back a parsed object, but a text executor may
   *  surface it as a string (parsed defensively in mapCellRow). */
  metadata: Record<string, unknown> | string | null
  /** AQU-1240: opaque lanes.id. Null while backfill is in flight. */
  lane_id: string | null
}

export interface CellRowOut {
  cellId: string
  side: "source" | "target"
  /** AQU-538: target-language lane. '' = default lane; always '' on source rows. */
  targetLang: string
  value: string
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  anchorCellId: string | null
  eventId: string
  sourceEventId: string | null
  lastEditor: string | null
  lastEditAt: number
  validated: boolean
  aiDrafted: boolean
  aiDraft: AiDraftProvenance | null
  wordCount: number
  endorsementCount: number
  startMs: number | null
  endMs: number | null
  medium: string | null
  sequenceIndex: number | null
  transcription: string | null
  cameraState: string | null
  metadata: Record<string, unknown> | null
  /** AQU-1240: opaque lanes.id. Null while backfill is in flight. Always
   *  emitted by {@link mapCellRow}; optional on hand-built fixtures. */
  laneId?: string | null
}

/** JSONB comes back as a parsed object from the Postgres driver; a text
 *  executor (or a JSON-as-text shim) may hand back a string instead — parse
 *  it defensively so the client always sees `metadata?: object | null`. */
function parseMetadata(
  raw: Record<string, unknown> | string | null,
): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return raw
}

function parseAiDraft(raw: AiDraftProvenance | string | null): AiDraftProvenance | null {
  if (raw == null) return null
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as AiDraftProvenance
      return parsed && typeof parsed === "object" ? parsed : null
    } catch {
      return null
    }
  }
  return raw
}

export function mapCellRow(row: CellRowRaw): CellRowOut {
  return {
    cellId: row.cell_id,
    side: row.side,
    targetLang: row.target_lang ?? "",
    value: row.value,
    valueHtml: row.value_html,
    type: row.type,
    canonicalRef: row.canonical_ref,
    anchorCellId: row.anchor_cell_id,
    eventId: row.event_id,
    sourceEventId: row.source_event_id,
    lastEditor: row.last_editor,
    lastEditAt: row.last_edit_at,
    validated: row.validated === 1,
    aiDrafted: row.ai_drafted === 1,
    aiDraft: row.ai_drafted === 1 ? parseAiDraft(row.ai_draft) : null,
    wordCount: row.word_count,
    endorsementCount: row.endorsement_count ?? 0,
    startMs: row.start_ms,
    endMs: row.end_ms,
    medium: row.medium,
    sequenceIndex: row.sequence_index,
    transcription: row.transcription,
    cameraState: row.camera_state,
    metadata: parseMetadata(row.metadata),
    laneId: row.lane_id ?? null,
  }
}
