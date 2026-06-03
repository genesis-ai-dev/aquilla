// Project-scoped cell read route.
//
//   GET /api/v1/projects/:projectId/files/:fileId/cells
//
// Query params:
//   side=source|target  — optional. If omitted, returns BOTH sides; the
//                         client renders them side-by-side using shared
//                         cell_id pairing (AD-9). Pass a value when a
//                         single side is wanted (e.g. read-only spectator
//                         views).
//   limit=N             — page size. Default 500, max 2000.
//   cursor=...          — opaque pagination cursor; the previous response's
//                         `nextCursor`.
//
// Ordering: cells are returned in **anchor-chain order**. The chain head is
// the cell with `anchor_cell_id IS NULL`; the next cell is the one whose
// `anchor_cell_id` equals the head's `cell_id`; and so on. When two cells
// claim the same anchor (importer inserted siblings) we use `event_id` lex
// order as the deterministic tiebreaker — matches spec §03-data-model
// "Ordering inside a file."
//
// When both sides are requested, the chain is walked independently per
// side. The client pairs by `cell_id` (AD-9) after receiving the rows.
//
// Auth: sync-token JWT scoped to `projectId`; minimum role viewer (100).

import { verifyTokenForProject } from "../auth"

export interface CellsReadEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

interface CellRowRaw {
  cell_id: string
  side: "source" | "target"
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
  word_count: number
  endorsement_count: number
  start_ms: number | null
  end_ms: number | null
  medium: string | null
  sequence_index: number | null
  transcription: string | null
  camera_state: string | null
}

interface CellRowOut {
  cellId: string
  side: "source" | "target"
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
  wordCount: number
  endorsementCount: number
  startMs: number | null
  endMs: number | null
  medium: string | null
  sequenceIndex: number | null
  transcription: string | null
  cameraState: string | null
}

function mapRow(row: CellRowRaw): CellRowOut {
  return {
    cellId: row.cell_id,
    side: row.side,
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
    wordCount: row.word_count,
    endorsementCount: row.endorsement_count ?? 0,
    startMs: row.start_ms,
    endMs: row.end_ms,
    medium: row.medium,
    sequenceIndex: row.sequence_index,
    transcription: row.transcription,
    cameraState: row.camera_state,
  }
}

/**
 * Walk the anchor chain for one side. Builds an index by anchor_cell_id
 * → ordered list of children (sorted by event_id for the sibling tiebreak),
 * then descends from the head (anchor_cell_id IS NULL).
 *
 * O(n) — every row is visited exactly once both at index build and at walk
 * time. Robust to cycles via the `visited` set; a malformed projection
 * (cycle) returns whatever chain prefix was reachable before the loop.
 *
 * Orphan cells (those whose anchor doesn't resolve to a known cell on this
 * side) are appended at the tail in event_id order — they'd otherwise drop
 * out entirely, which is the wrong default for a read API that should
 * surface everything in the projection.
 */
function walkAnchorChain(rows: CellRowRaw[]): CellRowRaw[] {
  if (rows.length === 0) return []

  // anchor_cell_id (null → "") → ordered children by event_id.
  const byAnchor = new Map<string, CellRowRaw[]>()
  const cellIds = new Set<string>()
  for (const r of rows) {
    cellIds.add(r.cell_id)
    const key = r.anchor_cell_id ?? ""
    let bucket = byAnchor.get(key)
    if (!bucket) {
      bucket = []
      byAnchor.set(key, bucket)
    }
    bucket.push(r)
  }
  for (const bucket of byAnchor.values()) {
    bucket.sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0))
  }

  const ordered: CellRowRaw[] = []
  const visited = new Set<string>()

  // Depth-first descent from the head. Each cell's id becomes the anchor
  // key for the next layer. We process siblings in ascending event_id
  // order: the first sibling's whole sub-chain is emitted before moving to
  // the next sibling. Iterative to avoid stack overflow on Bible-sized
  // files (~30k cells per side).
  //
  // The stack carries (anchorKey, indexIntoChildren) frames so we can
  // resume after recursing into a child. Visiting a child appends it to
  // `ordered` and pushes a new frame for its descendants.
  type Frame = { key: string; i: number }
  const stack: Frame[] = [{ key: "", i: 0 }] // "" = null anchor (head)

  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    const children = byAnchor.get(top.key)
    if (!children || top.i >= children.length) {
      stack.pop()
      continue
    }
    const child = children[top.i]
    top.i++
    if (visited.has(child.cell_id)) continue
    visited.add(child.cell_id)
    ordered.push(child)
    stack.push({ key: child.cell_id, i: 0 })
  }

  // Append orphans (anchor points to a non-existent cell on this side, or
  // a cycle isolated them from the head). Stable order by event_id.
  if (visited.size < rows.length) {
    const orphans: CellRowRaw[] = []
    for (const r of rows) {
      if (!visited.has(r.cell_id)) orphans.push(r)
    }
    orphans.sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0))
    ordered.push(...orphans)
  }

  return ordered
}

interface Cursor {
  /** Index into the ordered chain to resume from. */
  offset: number
}

function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c))
}

function decodeCursor(s: string | null): Cursor | null {
  if (!s) return null
  try {
    const parsed = JSON.parse(atob(s)) as Cursor
    if (typeof parsed.offset !== "number" || parsed.offset < 0) return null
    return parsed
  } catch {
    return null
  }
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/cells$/

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 2000

export async function handleCellsReadRequest(
  request: Request,
  env: CellsReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_DB) {
    return new Response("AQUILLA_DB binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  const qSide = url.searchParams.get("side")
  let sideFilter: "source" | "target" | null = null
  if (qSide !== null) {
    if (qSide !== "source" && qSide !== "target") {
      return new Response("invalid side: must be source or target", { status: 400 })
    }
    sideFilter = qSide
  }

  let limit = DEFAULT_LIMIT
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    if (!isNaN(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed))
    }
  }

  const cursor = decodeCursor(url.searchParams.get("cursor"))

  // Pull every row for the file in one query — anchor-chain ordering is
  // computed in memory. A Bible file is ~30k cells per side ≈ a few MB of
  // text; pulling once and ordering is faster than emitting one query per
  // chain step. For very large files this could be paginated by anchor key,
  // but the v1 SLO target is "open a project, render cells" and the chain
  // walk dominates only at >10x current file sizes.
  const columns =
    "cell_id, side, value, value_html, type, canonical_ref, anchor_cell_id, " +
    "event_id, source_event_id, last_editor, last_edit_at, validated, word_count, " +
    "endorsement_count, start_ms, end_ms, " +
    "medium, sequence_index, transcription, camera_state"

  // Per-cell fast path: when `cellIds=a,b,c` is present we skip chain walking
  // and just return matching rows. Used by the WS-triggered single-cell
  // revalidate path so a remote validate doesn't trigger a full file refetch.
  // Capped to keep this from being abused as a bulk read; legitimate WS
  // bursts coalesce to a handful of cells at most.
  const qCellIds = url.searchParams.get("cellIds")
  const cellIdsFilter = qCellIds
    ? qCellIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 100)
    : null

  const parts: string[] = [
    `SELECT ${columns}`,
    "FROM cells",
    "WHERE project_id = ? AND file_id = ?",
  ]
  const binds: unknown[] = [projectId, fileId]
  if (sideFilter !== null) {
    parts.push("AND side = ?")
    binds.push(sideFilter)
  }
  if (cellIdsFilter && cellIdsFilter.length > 0) {
    const placeholders = cellIdsFilter.map(() => "?").join(", ")
    parts.push(`AND cell_id IN (${placeholders})`)
    binds.push(...cellIdsFilter)
  }
  const sql = parts.join(" ")

  const result = await env.AQUILLA_DB.prepare(sql).bind(...binds).all<CellRowRaw>()
  const allRows = result.results

  let ordered: CellRowRaw[]
  if (cellIdsFilter && cellIdsFilter.length > 0) {
    // Targeted read: skip chain walking; preserve request order so callers
    // patching by index can rely on it. Pagination is moot at this scale.
    const byId = new Map<string, CellRowRaw[]>()
    for (const r of allRows) {
      let bucket = byId.get(r.cell_id)
      if (!bucket) {
        bucket = []
        byId.set(r.cell_id, bucket)
      }
      bucket.push(r)
    }
    ordered = []
    for (const id of cellIdsFilter) {
      const bucket = byId.get(id)
      if (bucket) ordered.push(...bucket)
    }
  } else if (sideFilter === null) {
    // Chain-walk source and target independently; emit source first, then
    // target, each in chain order. The client pairs by cell_id.
    const sourceRows: CellRowRaw[] = []
    const targetRows: CellRowRaw[] = []
    for (const r of allRows) {
      if (r.side === "source") sourceRows.push(r)
      else if (r.side === "target") targetRows.push(r)
    }
    ordered = [...walkAnchorChain(sourceRows), ...walkAnchorChain(targetRows)]
  } else {
    ordered = walkAnchorChain(allRows)
  }

  const offset = cursor?.offset ?? 0
  const slice = ordered.slice(offset, offset + limit)
  const nextOffset = offset + slice.length
  const hasMore = nextOffset < ordered.length

  return Response.json({
    cells: slice.map(mapRow),
    nextCursor: hasMore ? encodeCursor({ offset: nextOffset }) : null,
    total: ordered.length,
  })
}
