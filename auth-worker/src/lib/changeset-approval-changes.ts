// Per-cell before/after resolution for the changeset approval page (AQU-533
// §3). Split out of routes/changeset-approvals.ts so that route stays a thin
// authorization + lifecycle surface; this module is pure read-side rendering.
//
// The command JSONB is written by sync-worker/src/external/commands.ts; only
// the fields the approval page renders are read here, tolerating unknown
// extras.
//
// The per-cell map keys join on a NUL separator (mirroring sync-worker's
// cellKey); written as the \u0000 ESCAPE rather than a raw NUL byte so the
// file stays plain text and diffs are reviewable. Same string value.

import type { AuthHonoEnv } from "../middleware/auth"

/** Hard cap on per-cell change rows returned to the approval page. A plan can
 *  hold thousands of SetTranslation commands; the page needs enough to audit,
 *  not the whole plan — `changes.total`/`truncated` tell the reviewer what was
 *  cut. */
const MAX_APPROVAL_CHANGES = 200

/** Sample cells surfaced for a PlanImport command on the approval page. */
const MAX_IMPORT_SAMPLE_CELLS = 10

// Minimal structural views of sync-worker command shapes (the JSONB is written
// by sync-worker/src/external/commands.ts; we read only the fields the
// approval page renders, tolerating unknown extras).
interface SetTranslationCommandLike {
  kind: "SetTranslation"
  fileId: string
  cellId: string
  value: string
  laneId?: string
}

interface PlanImportCommandLike {
  kind: "PlanImport"
  fileName: string
  fileType: string
  cells?: { content?: string; canonicalRef?: string }[]
}

/** One per-cell change row for the approval page: what the reviewer actually
 *  approves — current text vs the text the agent wants to write. */
export interface ApprovalChange {
  fileId: string
  fileName: string | null
  cellId: string
  /** Target-language lane ('' / absent = the default lane). */
  laneId?: string
  canonicalRef: string | null
  /** Current source-side text of the cell (context for the reviewer). */
  source: string | null
  /** Current target text in this lane; null = a brand-new translation. */
  before: string | null
  /** The text the changeset will write. */
  after: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function parseJson<T>(v: unknown): T {
  if (v == null) return v as T
  if (typeof v === "string") return JSON.parse(v) as T
  return v as T
}

/** Resolve the per-cell before/after view for every SetTranslation command,
 *  plus a sample preview for a PlanImport command, against the live `cells`
 *  and `files` projections. Read-only; the digest still gates approval, so a
 *  cell drifting between render and approve is caught at commit (plan_stale),
 *  not here. */
export async function buildChangeDetails(
  db: AuthHonoEnv["Bindings"]["AQUILLA_PG"],
  projectId: string,
  commandsRaw: unknown,
): Promise<{
  changes?: { total: number; truncated: boolean; items: ApprovalChange[] }
  importPreview?: {
    fileName: string
    fileType: string
    totalCells: number
    sampleCells: { canonicalRef: string | null; content: string }[]
  }
}> {
  const commands = parseJson<unknown>(commandsRaw)
  if (!Array.isArray(commands)) return {}

  const sets = commands.filter(
    (cmd): cmd is SetTranslationCommandLike =>
      isRecord(cmd) &&
      cmd.kind === "SetTranslation" &&
      typeof cmd.fileId === "string" &&
      typeof cmd.cellId === "string" &&
      typeof cmd.value === "string",
  )
  const planImport = commands.find(
    (cmd): cmd is PlanImportCommandLike => isRecord(cmd) && cmd.kind === "PlanImport",
  )

  const result: Awaited<ReturnType<typeof buildChangeDetails>> = {}

  if (planImport) {
    const cells = Array.isArray(planImport.cells) ? planImport.cells : []
    result.importPreview = {
      fileName: typeof planImport.fileName === "string" ? planImport.fileName : "",
      fileType: typeof planImport.fileType === "string" ? planImport.fileType : "",
      totalCells: cells.length,
      sampleCells: cells.slice(0, MAX_IMPORT_SAMPLE_CELLS).map((cell) => ({
        canonicalRef: typeof cell.canonicalRef === "string" ? cell.canonicalRef : null,
        content: typeof cell.content === "string" ? cell.content : "",
      })),
    }
  }

  if (sets.length === 0) return result

  const shown = sets.slice(0, MAX_APPROVAL_CHANGES)

  // One row-value IN lookup for every (file, cell) pair on the page; source
  // rows give context, lane-matched target rows give the "before" text.
  const pairs = [...new Map(shown.map((s) => [`${s.fileId}\u0000${s.cellId}`, s])).values()]
  const inList = pairs.map(() => "(?, ?)").join(", ")
  const cellRows = await db
    .prepare(
      `SELECT file_id, cell_id, side, target_lang, value, canonical_ref
         FROM cells
        WHERE project_id = ? AND (file_id, cell_id) IN (${inList})`,
    )
    .bind(projectId, ...pairs.flatMap((p) => [p.fileId, p.cellId]))
    .all<{
      file_id: string
      cell_id: string
      side: string
      target_lang: string
      value: string
      canonical_ref: string | null
    }>()

  const sourceByCell = new Map<string, { value: string; canonicalRef: string | null }>()
  const targetByLane = new Map<string, string>()
  for (const row of cellRows.results ?? []) {
    const key = `${row.file_id}\u0000${row.cell_id}`
    if (row.side === "source") {
      sourceByCell.set(key, { value: row.value, canonicalRef: row.canonical_ref })
    } else {
      targetByLane.set(`${key}\u0000${row.target_lang}`, row.value)
    }
  }

  const fileIds = [...new Set(shown.map((s) => s.fileId))]
  const fileRows = await db
    .prepare(
      `SELECT id, name FROM files
        WHERE project_id = ? AND id IN (${fileIds.map(() => "?").join(", ")})`,
    )
    .bind(projectId, ...fileIds)
    .all<{ id: string; name: string }>()
  const fileNames = new Map((fileRows.results ?? []).map((f) => [f.id, f.name]))

  result.changes = {
    total: sets.length,
    truncated: sets.length > shown.length,
    items: shown.map((s) => {
      const key = `${s.fileId}\u0000${s.cellId}`
      const lane = s.laneId ?? ""
      const source = sourceByCell.get(key)
      return {
        fileId: s.fileId,
        fileName: fileNames.get(s.fileId) ?? null,
        cellId: s.cellId,
        ...(lane !== "" ? { laneId: lane } : {}),
        canonicalRef: source?.canonicalRef ?? null,
        source: source?.value ?? null,
        before: targetByLane.get(`${key}\u0000${lane}`) ?? null,
        after: s.value,
      }
    }),
  }
  return result
}
