// Project-scoped file read routes.
//
//   GET /api/v1/projects/:projectId/files            (?trash=1, ?limit=&cursor=)
//   GET /api/v1/projects/:projectId/files/:fileId
//
// The listing returns { files, nextCursor }. `limit` (max 500) turns on keyset
// paging; `nextCursor` is null when there is no further page. Without `limit`
// every file comes back in one response, as before.
//
// Both return the same shape (one record vs an array). Reads the `files`
// table directly — the rollup counters there are projected from the event
// log via writeProjection() on every onSave, so a /files response is the
// dashboard's view of the project without round-tripping through Y.Doc.
//
// Auth: Authorization: Bearer <sync-token JWT>. The token's `projectId`
// claim must match the path's :projectId. Token role is implicitly the
// project-membership check (identity mints tokens only for members).

import { verifyTokenForProject } from "../auth"

export interface FilesReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface FileRowRaw {
  id: string
  project_id: string
  name: string
  role: string | null
  kind: string | null
  anchor_file_id: string | null
  event_id: string
  meta: string
  cell_count: number
  approved_count: number
  filled_count: number
  word_count: number
  last_edit_at: number | null
  deleted_at: number | null
}

interface FileSummary {
  fileId: string
  projectId: string
  name: string
  /** Backward-compatible: derived from `kind ?? role ?? 'codex'`. */
  fileType: string
  role: string | null
  kind: string | null
  /** The file this one hangs off. A `role: "audio-cues"` sibling points at the
   *  text file whose timeline its cues annotate; that pairing is the only link
   *  between them, since the sibling never appears in a file list. Null on
   *  ordinary files. */
  anchorFileId: string | null
  eventId: string
  sourceLanguage: string | null
  targetLanguage: string | null
  sourceTextDirection: 'ltr' | 'rtl' | null
  targetTextDirection: 'ltr' | 'rtl' | null
  /** Timeline-segment-model order lens, read from meta. Null ⇒ client treats
   *  it as 'sequence'. */
  orderedBy: string | null
  /** Timeline editor: core video URL for the preview, read from meta. Null ⇒
   *  no video linked. */
  coreMediaUrl: string | null
  /** The file's audio timing mode (file.timing.set), read from meta. Null ⇒
   *  the project-level default applies. */
  timingMode: 'dubbing' | 'audioFirst' | null
  /**
   * What the audio-VTT import did about drift, read from
   * `meta.aquillaImport.audioVtt.timebase`. Null on every file that is not an
   * audio-cue sibling, and on siblings imported before this was recorded.
   *
   * Forwarded rather than recomputed: the measurement happened once, against
   * the reference file, at import — there is nothing here that could measure it
   * again, and a second opinion that disagreed with the correction actually
   * applied would be worse than silence. The project report reads this to say
   * whether an episode's cues were corrected, aligned, or never measurable.
   */
  audioVttTimebase: { fromFps?: string; toFps?: string; scale: number } | null
  /** Per-track deltas keyed by track id (file.track.set), read from meta —
   *  NEVER the full track list, which the client derives. Null ⇒ the file
   *  draws the three defaults. Patch fields stay widened (`kind: string`)
   *  because a newer client may have persisted a kind this build cannot name;
   *  the route's job is to forward it intact, not to judge it. */
  trackOverrides: Record<
    string,
    { kind?: string; name?: string; order?: number; groupId?: string; color?: string; sourceTrackId?: string }
  > | null
  cellCount: number
  approvedCount: number
  /** Target cells with content (TRIM(value) != ''): the "translated" count. */
  filledCount: number
  wordCount: number
  lastEditAt: number | null
  /** AQU-272: epoch-ms when this file was soft-deleted, or null if active. */
  deletedAt: number | null
}

/** Shape-check the recorded correction. `scale` is the only field that must be
 *  there — a drift measured from the words is exact even when neither frame
 *  rate could be named (24-against-23.976 and 30-against-29.97 are the same
 *  ratio), so the labels are optional by design. */
function normalizeTimebase(raw: unknown): FileSummary['audioVttTimebase'] {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as { fromFps?: unknown; toFps?: unknown; scale?: unknown }
  if (typeof t.scale !== 'number' || !Number.isFinite(t.scale)) return null
  return {
    ...(typeof t.fromFps === 'string' ? { fromFps: t.fromFps } : {}),
    ...(typeof t.toFps === 'string' ? { toFps: t.toFps } : {}),
    scale: t.scale,
  }
}

function mapRow(row: FileRowRaw): FileSummary {
  let meta: {
    source_language?: string
    target_language?: string
    sourceLanguage?: string
    targetLanguage?: string
    source_text_direction?: string
    target_text_direction?: string
    sourceTextDirection?: string
    targetTextDirection?: string
    orderedBy?: string
    coreMediaUrl?: string
    timingMode?: string
    trackOverrides?: unknown
    aquillaImport?: { audioVtt?: { timebase?: unknown } }
  } = {}
  try {
    meta = row.meta ? JSON.parse(row.meta) : {}
  } catch {
    meta = {}
  }
  return {
    fileId: row.id,
    projectId: row.project_id,
    name: row.name,
    fileType: row.kind ?? row.role ?? 'codex',
    role: row.role,
    kind: row.kind,
    anchorFileId: row.anchor_file_id,
    eventId: row.event_id,
    sourceLanguage: meta.source_language ?? meta.sourceLanguage ?? null,
    targetLanguage: meta.target_language ?? meta.targetLanguage ?? null,
    sourceTextDirection: normalizeTextDirection(meta.source_text_direction ?? meta.sourceTextDirection),
    targetTextDirection: normalizeTextDirection(meta.target_text_direction ?? meta.targetTextDirection),
    orderedBy: meta.orderedBy ?? null,
    coreMediaUrl: meta.coreMediaUrl ?? null,
    timingMode: meta.timingMode === 'dubbing' || meta.timingMode === 'audioFirst' ? meta.timingMode : null,
    audioVttTimebase: normalizeTimebase(meta.aquillaImport?.audioVtt?.timebase),
    trackOverrides: normalizeTrackOverrides(meta.trackOverrides),
    cellCount: row.cell_count,
    approvedCount: row.approved_count,
    filledCount: row.filled_count,
    wordCount: row.word_count,
    lastEditAt: row.last_edit_at,
    deletedAt: row.deleted_at ?? null,
  }
}

function normalizeTextDirection(value: string | undefined): 'ltr' | 'rtl' | null {
  return value === 'ltr' || value === 'rtl' ? value : null
}

// Unlike the scalars above, this one is shape-checked rather than value-checked:
// an array is `typeof 'object'` and would reach the client's merge as a map with
// numeric keys, and the projection's delete branch (`#- ARRAY[…]`) can leave an
// empty map behind, which means the same thing as no key at all. Both collapse
// to null so the client has exactly one "no overrides" case to handle.
function normalizeTrackOverrides(value: unknown): FileSummary['trackOverrides'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const overrides = value as NonNullable<FileSummary['trackOverrides']>
  return Object.keys(overrides).length > 0 ? overrides : null
}

// Active listing:  GET /api/v1/projects/:projectId/files
// Single file:     GET /api/v1/projects/:projectId/files/:fileId
// Trash listing:   GET /api/v1/projects/:projectId/files?trash=1
const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files(?:\/([^/]+))?$/

export async function handleFilesReadRequest(
  request: Request,
  env: FilesReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = match[2] ? decodeURIComponent(match[2]) : null

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  // Threshold-aware approved count. `files.approved_count` (maintained by
  // fileCountersRecomputeStmt) counts `cells.validated`, which ignores the
  // project's validationCount, so it is only the fallback for files that have
  // no projected progress row. For projected files the count is the histogram
  // mass at or above the threshold. The threshold is resolved ONCE in a CTE:
  // the previous shape re-parsed `project_settings.settings` as jsonb inside a
  // correlated subquery, i.e. per histogram bucket per file row.
  const columns =
    "f.id, f.project_id, f.name, f.role, f.kind, f.anchor_file_id, f.event_id, f.meta, " +
    "COALESCE(p.total_count, f.cell_count) AS cell_count, " +
    "CASE WHEN p.file_id IS NULL THEN f.approved_count ELSE COALESCE(a.approved, 0) END AS approved_count, " +
    "COALESCE(p.filled_count, f.filled_count) AS filled_count, " +
    "f.word_count, f.last_edit_at, f.deleted_at"
  const thresholdCte =
    "WITH thr AS (SELECT LEAST(15, GREATEST(1, CASE WHEN (settings::jsonb->>'validationCount') ~ '^[0-9]+$' " +
    "THEN (settings::jsonb->>'validationCount')::integer ELSE 1 END)) AS n FROM project_settings WHERE project_id = ?)"
  const joins =
    // AQU-538: file_section_progress now materializes one row per target lane.
    // The files list is a cross-project legacy surface — pin it to the default
    // lane ('') so N=1 stays byte-identical and N>1 files don't fan out into
    // one listing row per lane.
    " LEFT JOIN file_section_progress p ON p.project_id = f.project_id AND p.file_id = f.id AND p.scope = 'file' AND p.section_key = '' AND p.target_lang = ''" +
    " LEFT JOIN thr ON true" +
    " LEFT JOIN LATERAL (SELECT SUM(entry.value::integer)::integer AS approved FROM jsonb_each_text(p.validator_histogram) entry WHERE entry.key::integer >= COALESCE(thr.n, 1)) a ON true"
  const orderBy = "ORDER BY f.last_edit_at DESC NULLS LAST, f.name ASC, f.id ASC"

  // ?trash=1 returns soft-deleted files only; default returns active files only.
  const trash = url.searchParams.get("trash") === "1"

  if (fileId) {
    const sql = `${thresholdCte} SELECT ${columns} FROM files f${joins} WHERE f.project_id = ? AND f.id = ?`
    const row = await env.AQUILLA_PG.prepare(sql)
      .bind(projectId, projectId, fileId)
      .first<FileRowRaw>()
    if (!row) return new Response("file not found", { status: 404 })
    return Response.json({ file: mapRow(row) })
  }

  // ?limit=&cursor= keyset pagination over (last_edit_at DESC NULLS LAST,
  // name ASC, id ASC). Without `limit` the listing is unpaged, exactly as
  // before; `nextCursor` is null on the last (or only) page.
  const limitRaw = url.searchParams.get("limit")
  const limit = limitRaw === null ? null : parseFilesLimit(limitRaw)
  if (limitRaw !== null && limit === null) return new Response("invalid limit", { status: 400 })
  const cursorRaw = url.searchParams.get("cursor")
  const cursor = cursorRaw ? decodeFilesCursor(cursorRaw) : null
  if (cursorRaw && !cursor) return new Response("invalid cursor", { status: 400 })

  const tombstoneFilter = trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"
  const where: string[] = [`f.project_id = ?`, `f.${tombstoneFilter}`]
  const binds: unknown[] = [projectId, projectId]
  if (cursor) {
    if (cursor.lastEditAt === null) {
      // Already inside the NULLS LAST tail: only later (name, id) NULL rows remain.
      where.push("f.last_edit_at IS NULL AND (f.name > ? OR (f.name = ? AND f.id > ?))")
      binds.push(cursor.name, cursor.name, cursor.id)
    } else {
      where.push(
        "(f.last_edit_at < ? OR f.last_edit_at IS NULL OR (f.last_edit_at = ? AND (f.name > ? OR (f.name = ? AND f.id > ?))))",
      )
      binds.push(cursor.lastEditAt, cursor.lastEditAt, cursor.name, cursor.name, cursor.id)
    }
  }
  // Page `files` FIRST, then join the progress/histogram work onto only the
  // rows that made the page. Joining before the sort makes the planner
  // expand every file's histogram just to discard all but one page; on
  // PGlite that is the difference between ~60 ms and ~1.4 s at 1000 files.
  // The outer ORDER BY re-asserts the order the CTE produced.
  const pageSql =
    `SELECT * FROM files f WHERE ${where.join(" AND ")} ${orderBy}` +
    (limit !== null ? " LIMIT ?" : "")
  if (limit !== null) binds.push(limit + 1)
  const sql =
    `${thresholdCte}, page AS (${pageSql}) SELECT ${columns} FROM page f${joins} ${orderBy}`
  const result = await env.AQUILLA_PG.prepare(sql)
    .bind(...binds)
    .all<FileRowRaw>()
  const rows = result.results
  const page = limit !== null && rows.length > limit ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor =
    limit !== null && rows.length > limit && last
      ? encodeFilesCursor({
          lastEditAt: last.last_edit_at === null ? null : Number(last.last_edit_at),
          name: last.name,
          id: last.id,
        })
      : null
  return Response.json({ files: page.map(mapRow), nextCursor })
}

export const FILES_MAX_PAGE = 500

interface FilesCursor {
  lastEditAt: number | null
  name: string
  id: string
}

function parseFilesLimit(raw: string): number | null {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return null
  return Math.min(n, FILES_MAX_PAGE)
}

/** Opaque keyset cursor: base64url JSON of the last row's sort key. */
export function encodeFilesCursor(c: FilesCursor): string {
  return btoa(JSON.stringify([c.lastEditAt, c.name, c.id]))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeFilesCursor(raw: string): FilesCursor | null {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/")
    const parsed: unknown = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)))
    if (!Array.isArray(parsed) || parsed.length !== 3) return null
    const [lastEditAt, name, id] = parsed as unknown[]
    if (lastEditAt !== null && (typeof lastEditAt !== "number" || !Number.isFinite(lastEditAt))) return null
    if (typeof name !== "string" || typeof id !== "string" || !id) return null
    return { lastEditAt, name, id }
  } catch {
    return null
  }
}
