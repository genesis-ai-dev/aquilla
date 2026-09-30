// Types for the sync-worker read API (server-side reads, AD-3 v1 thin client).
//
// Mirror of the server's response shapes in:
//   sync-worker/src/events/files-read-route.ts
//   sync-worker/src/events/cells-read-route.ts
//
// These will move into `packages/data-model` in Phase 3 (one canonical
// definition shared by every Worker + the web client). Until then we keep
// them local — Phase 2's hook migration only depends on the surface
// described here, not on its physical location.

import type { AiDraftProvenance } from "./outbox-types"

/**
 * File-level rollup row, as returned by GET /api/v1/projects/:projectId/files.
 * `cellCount` / `approvedCount` / `wordCount` / `lastEditAt` are projected
 * from the cell.commit event stream (see writeProjection on the server).
 */
export interface FileSummary {
  fileId: string
  projectId: string
  name: string
  /** e.g. "codex", "source", "vtt". Matches the FileType enum on the client. */
  fileType: string
  /** The raw `role`/`kind` columns behind `fileType` (which is `kind ?? role`,
   *  and so cannot distinguish an audio-cue sibling — role "audio-cues", kind
   *  "vtt" — from a plain subtitle import). The route has always sent both;
   *  declaring them is what lets a consumer of this shape, notably the Trash
   *  listing, filter the hidden siblings out. */
  role?: string | null
  kind?: string | null
  /** The text file an audio-cue sibling annotates. Null on ordinary files. */
  anchorFileId?: string | null
  sourceLanguage: string | null
  targetLanguage: string | null
  sourceTextDirection?: "ltr" | "rtl" | null
  targetTextDirection?: "ltr" | "rtl" | null
  cellCount: number
  approvedCount: number
  /** Target cells with content (TRIM(value) != ''): the "translated" count,
   *  distinct from approvedCount (validated). Matches the chapter-dot signal. */
  filledCount: number
  wordCount: number
  /** Last cell.commit timestamp on this file. Null on freshly-created files. */
  lastEditAt: number | null
  /** AQU-272: epoch-ms when this file was soft-deleted, or null when active. */
  deletedAt?: number | null
  /** AQU-656: original import blob exists. Absent on older sync-workers. */
  hasOriginalSource?: boolean
}

/**
 * One cell row from GET /api/v1/projects/:projectId/files/:fileId/cells.
 * Paired source/target cells share a `cellId`; the `side` field distinguishes
 * them. Anchor-chain order is computed server-side, so consumers can render
 * the array as-is. See AD-9 in spec 02-foundations.md for the dual-side model.
 */
export interface CellRow {
  cellId: string
  side: "source" | "target"
  /**
   * AQU-538: target-language lane. '' = the file's single configured target
   * language (the default lane — every pre-lane row, and all rows in projects
   * that never add a second language). Always '' on source rows: the source
   * is shared by all lanes. Optional so cached/older responses parse.
   */
  targetLang?: string
  value: string
  /** Rich-text variant. Null for plain-text cells. */
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  anchorCellId: string | null
  /** AD-2 chain head: id of the most recent winning event on this row. */
  eventId: string
  /** AD-9 staleness pin: the source cell's event_id observed at commit time.
   *  Only populated for target-side rows that have been committed against a
   *  source. Null on source-side rows and target-owned cells. */
  sourceEventId: string | null
  lastEditor: string | null
  lastEditAt: number
  validated: boolean
  /** True while the current target head is an untouched machine draft. */
  aiDrafted?: boolean
  /** Reproducible evidence/model snapshot for the current untouched AI draft. */
  aiDraft?: AiDraftProvenance | null
  wordCount: number
  endorsementCount?: number
  /** Cue start/end in milliseconds; null for non-subtitle cells. */
  startMs?: number | null
  endMs?: number | null
  /**
   * Timeline-segment-model (Scope A). All additive; absent on legacy rows.
   * - `sequenceIndex`: intrinsic order key. Fractional values are allowed so a
   *   segment can be inserted *between* two others without renumbering.
   * - `medium`: primary content kind. Absent → `'text'`.
   * - `transcription`: ASR / corrected source text for a media clip.
   * - `cameraState`: lip-sync constraint tag for media segments.
   */
  sequenceIndex?: number | null
  medium?: SegmentMedium | null
  transcription?: string | null
  cameraState?: CameraState | null
  /**
   * Extensible per-cell metadata bucket (mirrors the event-log payload's
   * extensibility). OBS populates `attachments: [{ type:"image", url, alt }]`
   * per frame; future localization workflows add gif/video/audio without a
   * schema change. Absent on legacy rows. Stored as JSONB server-side;
   * arrives parsed as an object (cells-read.ts normalizes a JSON string).
   */
  metadata?: Record<string, unknown> | null
  /**
   * AQU-1422: true while this cell is parked ("Hide cell"). Absent on a visible
   * row — the server omits the key rather than sending `false` on every one of a
   * Bible file's 30k rows.
   *
   * ONLY THE SOURCE ROW CARRIES IT. Read a cell's visibility off its source row,
   * never off a target row: hiding is per cell, not per lane, and a target row
   * created after the hide (a collaborator's in-flight translation, which must
   * survive) has no flag of its own.
   */
  hidden?: boolean
}

/** Primary content kind of a segment. */
export type SegmentMedium = "text" | "media"

/**
 * Camera state for a media segment (Wendi's lip-sync constraint).
 *
 * `group` is the fourth value and the newest (AQU-646, 2026-08-20). The client
 * spreadsheets have always used it — a shot with several people in frame — and
 * both importers used to fold it into `mixed` on the way in, which meant it
 * could never come back out of an export. Sam, on seeing that in a real
 * corrected workbook: "If those are separate camera labels, then they need to
 * remain separate camera labels throughout the project."
 *
 * The column behind this is plain TEXT with no constraint, so widening the
 * union needed no migration — the value was always storable, just never
 * produced.
 */
export type CameraState = "on" | "mixed" | "off" | "group"

/** Pagination response shape. */
export interface CellsPage {
  cells: CellRow[]
  /** Opaque cursor for the next page. Null when no more rows exist. */
  nextCursor: string | null
  /** Total chain-walked rows for this query (across all pages). */
  total: number
}
