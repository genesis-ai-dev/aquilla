// Shared per-file segmentation domain logic.
//
// Lives in db/shared/ so the auth-worker route and the pipeline's tick apply
// the SAME validation and the SAME parameterized SQL, with no forked rules —
// the pattern scene-briefs.ts and agent-memory.ts already follow.
//
// What this owns: the three strategies, the validation that makes an explicit
// boundary list trustworthy, and the read/write primitives. Identity and
// authorization stay in the caller; this module never touches HTTP.
//
// The validation is the point. An explicit boundary list is the shape a model
// will eventually produce, and a model's boundaries are proposals, not facts:
// it can name a cell that does not exist, skip a stretch of the file, overlap
// two spans, or emit them out of order. Any one of those silently drops cells
// from every autopilot run over that file — work that never happens and is
// never reported as skipped. So the list is checked against the file's real
// ordered cell ids in code before it is ever stored.

import type { AquillaDb } from "../shim/postgres"

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type SegmentationStrategy = "auto" | "fixed" | "explicit"

/** Bounds on `fixedSize`, shared by the API and the UI so both refuse the
 *  same values. Mirrors MIN/MAX_FIXED_SIZE in the pipeline's segment.ts: a
 *  one-cell span leaves the construe loop no discourse to work with, and past
 *  the ceiling the draft node's reply truncates inside its token cap and the
 *  whole span is discarded. */
export const MIN_SEGMENT_SIZE = 2
export const MAX_SEGMENT_SIZE = 50

/** Ceiling on stored spans for one file. Generous — a long book segments into
 *  a few hundred — but bounded, so a runaway generator cannot write a row that
 *  no longer fits in a request. */
export const MAX_BOUNDARIES = 2000
export const MAX_TITLE_CHARS = 200
export const MAX_GIST_CHARS = 1000
export const MAX_NOTE_CHARS = 2000
/** Deepest nesting level an outline entry may claim (0 = top level). */
export const MAX_DEPTH = 4

/** One stored span. `title`/`gist`/`depth` are optional so a boundary list can
 *  be pure structure today and a navigable outline once a model fills them. */
export interface SegmentBoundary {
  startCellId: string
  endCellId: string
  title?: string
  gist?: string
  depth?: number
}

export interface FileSegmentation {
  projectId: string
  fileId: string
  strategy: SegmentationStrategy
  fixedSize: number | null
  boundaries: SegmentBoundary[] | null
  /** The human's extra instruction, kept for the next re-segmentation. */
  note: string | null
  generatedBy: "human" | "model" | null
  modelId: string | null
  /** True when a person set this; an automated pass must not overwrite it. */
  humanEdited: boolean
  staleSince: string | null
  staleReason: string | null
  version: number
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

/** What a caller may write. `strategy` decides which other fields are read. */
export interface SegmentationInput {
  strategy: SegmentationStrategy
  fixedSize?: number
  boundaries?: SegmentBoundary[]
  note?: string
  generatedBy?: "human" | "model"
  modelId?: string
  humanEdited?: boolean
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string }

// ──────────────────────────────────────────────────────────────────────────
// Validation (pure — no I/O, so both the route and its tests call it directly)
// ──────────────────────────────────────────────────────────────────────────

function clampSize(value: number): number {
  return Math.min(MAX_SEGMENT_SIZE, Math.max(MIN_SEGMENT_SIZE, Math.floor(value)))
}

/**
 * Check an explicit boundary list against the file's real ordered cell ids.
 *
 * Every rule here exists because breaking it loses work silently:
 *   - an unknown cell id resolves to nothing, so the span is dropped;
 *   - a gap leaves cells in no span, so no run ever drafts them;
 *   - an overlap drafts the same cell from two spans, and the second
 *     supersedes the first for no stated reason;
 *   - out-of-order spans make "the previous segment" meaningless, which is
 *     what the closure loop's neighbour context is built on.
 */
export function validateBoundaries(
  boundaries: unknown,
  orderedCellIds: string[],
): ValidationResult<SegmentBoundary[]> {
  if (!Array.isArray(boundaries)) return { ok: false, error: "boundaries must be an array" }
  if (boundaries.length === 0) return { ok: false, error: "boundaries must not be empty" }
  if (boundaries.length > MAX_BOUNDARIES) {
    return { ok: false, error: `boundaries must contain at most ${MAX_BOUNDARIES} entries` }
  }
  if (orderedCellIds.length === 0) return { ok: false, error: "file has no source cells" }

  const index = new Map(orderedCellIds.map((id, i) => [id, i]))
  const out: SegmentBoundary[] = []
  let expected = 0

  for (let i = 0; i < boundaries.length; i++) {
    const raw = boundaries[i] as Record<string, unknown>
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: `boundary ${i + 1} is not an object` }
    }
    const startCellId = raw.startCellId
    const endCellId = raw.endCellId
    if (typeof startCellId !== "string" || typeof endCellId !== "string") {
      return { ok: false, error: `boundary ${i + 1} needs string startCellId and endCellId` }
    }
    const start = index.get(startCellId)
    const end = index.get(endCellId)
    if (start === undefined) {
      return { ok: false, error: `boundary ${i + 1} names a startCellId not in this file` }
    }
    if (end === undefined) {
      return { ok: false, error: `boundary ${i + 1} names an endCellId not in this file` }
    }
    if (end < start) {
      return { ok: false, error: `boundary ${i + 1} ends before it starts` }
    }
    if (start !== expected) {
      return {
        ok: false,
        error:
          start < expected
            ? `boundary ${i + 1} overlaps the previous one`
            : `boundary ${i + 1} leaves a gap of ${start - expected} cell(s)`,
      }
    }
    expected = end + 1

    const entry: SegmentBoundary = { startCellId, endCellId }
    if (typeof raw.title === "string" && raw.title.trim()) {
      entry.title = raw.title.trim().slice(0, MAX_TITLE_CHARS)
    }
    if (typeof raw.gist === "string" && raw.gist.trim()) {
      entry.gist = raw.gist.trim().slice(0, MAX_GIST_CHARS)
    }
    if (typeof raw.depth === "number" && Number.isFinite(raw.depth)) {
      entry.depth = Math.min(MAX_DEPTH, Math.max(0, Math.floor(raw.depth)))
    }
    out.push(entry)
  }

  if (expected !== orderedCellIds.length) {
    return {
      ok: false,
      error: `boundaries cover ${expected} of ${orderedCellIds.length} cell(s) — every cell must belong to exactly one segment`,
    }
  }
  return { ok: true, value: out }
}

/** Validate a whole write. `orderedCellIds` is only consulted for 'explicit'. */
export function validateSegmentationInput(
  input: SegmentationInput,
  orderedCellIds: string[],
): ValidationResult<SegmentationInput> {
  if (input.note !== undefined && input.note.length > MAX_NOTE_CHARS) {
    return { ok: false, error: `note must be at most ${MAX_NOTE_CHARS} characters` }
  }
  switch (input.strategy) {
    case "auto":
      // Structure-derived: any size or boundary list sent alongside is
      // meaningless, so drop it rather than store a value nothing reads.
      return {
        ok: true,
        value: { strategy: "auto", ...(input.note !== undefined ? { note: input.note } : {}) },
      }
    case "fixed": {
      if (typeof input.fixedSize !== "number" || !Number.isFinite(input.fixedSize)) {
        return { ok: false, error: "fixedSize is required for the 'fixed' strategy" }
      }
      return {
        ok: true,
        value: {
          strategy: "fixed",
          fixedSize: clampSize(input.fixedSize),
          ...(input.note !== undefined ? { note: input.note } : {}),
        },
      }
    }
    case "explicit": {
      const checked = validateBoundaries(input.boundaries, orderedCellIds)
      if (!checked.ok) return checked
      return {
        ok: true,
        value: {
          strategy: "explicit",
          boundaries: checked.value,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
          ...(input.modelId ? { modelId: input.modelId } : {}),
        },
      }
    }
    default:
      return { ok: false, error: `unknown strategy '${String(input.strategy)}'` }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SQL primitives
// ──────────────────────────────────────────────────────────────────────────

interface Row {
  project_id: string
  file_id: string
  strategy: string
  fixed_size: number | string | null
  boundaries: unknown
  note: string | null
  generated_by: string | null
  model_id: string | null
  human_edited: boolean | number | null
  stale_since: string | null
  stale_reason: string | null
  version: number | string
  updated_by: string | null
  created_at: string
  updated_at: string
}

/** jsonb comes back as an object from `postgres` and as a string from some
 *  shim paths; normalize both, and never let a malformed blob throw into a
 *  run. */
function parseBoundaries(value: unknown): SegmentBoundary[] | null {
  if (value == null) return null
  if (Array.isArray(value)) return value as SegmentBoundary[]
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? (parsed as SegmentBoundary[]) : null
    } catch {
      return null
    }
  }
  return null
}

function toRecord(row: Row): FileSegmentation {
  const strategy: SegmentationStrategy =
    row.strategy === "fixed" || row.strategy === "explicit" ? row.strategy : "auto"
  const generatedBy = row.generated_by === "human" || row.generated_by === "model" ? row.generated_by : null
  return {
    projectId: row.project_id,
    fileId: row.file_id,
    strategy,
    fixedSize: row.fixed_size == null ? null : Number(row.fixed_size),
    boundaries: parseBoundaries(row.boundaries),
    note: row.note,
    generatedBy,
    modelId: row.model_id,
    humanEdited: row.human_edited === true || row.human_edited === 1,
    staleSince: row.stale_since,
    staleReason: row.stale_reason,
    version: Number(row.version),
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The stored segmentation, or null when the file has never been configured
 *  (which means 'auto' — the caller must not treat null as an error). */
export async function getFileSegmentation(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<FileSegmentation | null> {
  const row = await db
    .prepare(`SELECT * FROM file_segmentation WHERE project_id = ? AND file_id = ?`)
    .bind(projectId, fileId)
    .first<Row>()
  return row ? toRecord(row) : null
}

/**
 * Write the segmentation for one file.
 *
 * Every write clears the staleness marker: the caller has just restated what
 * the boundaries should be, so whatever made the old ones stale no longer
 * applies to these. `humanEdited` is sticky in the other direction — once a
 * person has set a segmentation, a later automated write cannot clear the pin
 * (it can still change the boundaries; the pin records that a human's
 * intention is in play, which is what a future automated pass checks).
 */
export async function setFileSegmentation(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  input: SegmentationInput,
  updatedBy: string | null,
): Promise<FileSegmentation> {
  const humanEdited = input.humanEdited === true
  const row = await db
    .prepare(
      `INSERT INTO file_segmentation
         (project_id, file_id, strategy, fixed_size, boundaries, note,
          generated_by, model_id, human_edited, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
       ON CONFLICT (project_id, file_id) DO UPDATE SET
         strategy     = excluded.strategy,
         fixed_size   = excluded.fixed_size,
         boundaries   = excluded.boundaries,
         note         = excluded.note,
         generated_by = excluded.generated_by,
         model_id     = excluded.model_id,
         human_edited = file_segmentation.human_edited OR excluded.human_edited,
         stale_since  = NULL,
         stale_reason = NULL,
         version      = file_segmentation.version + 1,
         updated_by   = excluded.updated_by,
         updated_at   = now()
       RETURNING *`,
    )
    .bind(
      projectId,
      fileId,
      input.strategy,
      input.strategy === "fixed" ? (input.fixedSize ?? null) : null,
      input.strategy === "explicit" ? JSON.stringify(input.boundaries ?? []) : null,
      input.note ?? null,
      input.generatedBy ?? (humanEdited ? "human" : null),
      input.modelId ?? null,
      humanEdited,
      updatedBy,
    )
    .first<Row>()
  if (!row) throw new Error("file_segmentation upsert returned no row")
  return toRecord(row)
}

/**
 * Mark a file's stored segmentation stale. Instant marker only — nothing
 * re-segments here. A stale row is still USED (stale boundaries beat no
 * boundaries); the marker exists so the UI can say so and a future pass knows
 * what to revisit.
 */
export async function markSegmentationStale(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  reason: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE file_segmentation
          SET stale_since = COALESCE(stale_since, now()), stale_reason = ?
        WHERE project_id = ? AND file_id = ? AND strategy = 'explicit'`,
    )
    .bind(reason, projectId, fileId)
    .run()
}
