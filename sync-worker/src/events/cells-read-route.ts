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
//   lane=<tag>          — AQU-538: optional. When present, target rows are
//                         filtered to `target_lang = <tag>`; source rows are
//                         ALWAYS included regardless. Applies to the full
//                         read, the delta (`?since=`) read, and the cellIds
//                         fast path alike. Absent = all lanes (unchanged).
//                         Max 64 chars; longer values are rejected with 400.
//   since=<serverSeq>   — delta read (audit M2-1). Returns only the cells
//                         touched by events with `server_seq > since`,
//                         unpaginated, as `{ delta: true, changedCellIds,
//                         cells, maxServerSeq }`. A changed cellId with no
//                         returned row means the cell was deleted (the client
//                         drops it). When the changed set exceeds
//                         DELTA_RESYNC_LIMIT — or when `since` predates the
//                         project's last projection rebuild (audit B5; the
//                         rebuild changed cells without minting events) —
//                         the response is `{ resync: true, maxServerSeq }`
//                         and the client falls back to a full stream.
//
// Conditional reads: every non-cellIds response carries
// `ETag: "<fileId>:<rebuiltSeq>:<maxSeq>"` where maxSeq = MAX(server_seq)
// over the file's events and rebuiltSeq is the project's rebuild marker
// (project_seq_counters.rebuilt_seq, 0 if never rebuilt) — both strictly
// ordering keys, NEVER counts (server_seq has harmless gaps from idempotent
// replays). A request with a matching `If-None-Match` returns 304 before any
// cells row is read. Full (non-delta) responses additionally carry
// `maxServerSeq` (= GREATEST of the pair) in the JSON body so cross-origin
// clients can build their next `?since=` cursor without reading response
// headers.
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
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface CellRowRaw {
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
  word_count: number
  endorsement_count: number
  start_ms: number | null
  end_ms: number | null
  medium: string | null
  sequence_index: number | null
  transcription: string | null
  camera_state: string | null
  /** JSONB — the driver hands back a parsed object, but a text executor may
   *  surface it as a string (parsed defensively in mapRow). */
  metadata: Record<string, unknown> | string | null
}

interface CellRowOut {
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
  wordCount: number
  endorsementCount: number
  startMs: number | null
  endMs: number | null
  medium: string | null
  sequenceIndex: number | null
  transcription: string | null
  cameraState: string | null
  metadata: Record<string, unknown> | null
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

function mapRow(row: CellRowRaw): CellRowOut {
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
    wordCount: row.word_count,
    endorsementCount: row.endorsement_count ?? 0,
    startMs: row.start_ms,
    endMs: row.end_ms,
    medium: row.medium,
    sequenceIndex: row.sequence_index,
    transcription: row.transcription,
    cameraState: row.camera_state,
    metadata: parseMetadata(row.metadata),
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

// Above this many changed cells a delta is no longer cheaper than a full
// stream (and the unpaginated response would balloon) — tell the client to
// resync. Bulk imports / bulk completions are the realistic way past it.
const DELTA_RESYNC_LIMIT = 500

interface Watermarks {
  /** MAX(server_seq) over the file's events; 0 for files with no events. */
  maxSeq: number
  /** The project's rebuild marker (audit B5): the seq the last projection
   *  rebuild allocated when it finished, 0 if never rebuilt. A rebuild
   *  changes cells without minting events, so maxSeq alone cannot see it. */
  rebuiltSeq: number
}

/** The ETag / `?since=` watermark pair, in one round-trip (both subqueries
 *  are indexed point/range reads). `Number()` normalizes the BIGINTs, which
 *  different executors surface as number | string | bigint. */
async function fetchWatermarks(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<Watermarks> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COALESCE(MAX(server_seq), 0) FROM events WHERE project_id = ? AND file_id = ?) AS max_seq,
         (SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?) AS rebuilt_seq`,
    )
    .bind(projectId, fileId, projectId)
    .first<{ max_seq: number | string | bigint; rebuilt_seq: number | string | bigint | null }>()
  return {
    maxSeq: Number(row?.max_seq ?? 0),
    // NULL when the project has no counter row yet (never wrote post-allocator,
    // never rebuilt) — behaves exactly as before the rebuild marker existed.
    rebuiltSeq: Number(row?.rebuilt_seq ?? 0),
  }
}

/** rebuiltSeq is folded in so conditional reads MISS after a rebuild even
 *  though MAX(server_seq) did not move. */
function makeEtag(fileId: string, w: Watermarks): string {
  return `"${fileId}:${w.rebuiltSeq}:${w.maxSeq}"`
}

/** The watermark advertised to clients as `maxServerSeq` (their next `?since=`
 *  cursor). Including rebuiltSeq is what terminates the resync: the full
 *  refetch hands back a cursor at/above the marker, so the client's next
 *  delta passes the `since < rebuiltSeq` gate instead of looping. Safe: no
 *  event at or below rebuiltSeq can ever be minted later (the rebuild bumped
 *  the allocator to it), so no delta is skipped. */
function advertisedSeq(w: Watermarks): number {
  return Math.max(w.maxSeq, w.rebuiltSeq)
}

/** Loose If-None-Match comparison: any listed value (optionally W/-prefixed)
 *  equal to our strong ETag counts as a match. */
function ifNoneMatchMatches(headerValue: string | null, etag: string): boolean {
  if (!headerValue) return false
  return headerValue
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === etag)
}

/** `private` — responses are authed and per-user-visible; `no-cache` — the
 *  browser may store but must revalidate (the ETag makes that a 304). */
function cacheHeaders(etag: string): HeadersInit {
  return { ETag: etag, "Cache-Control": "private, no-cache" }
}

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
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
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

  // AQU-538: optional lane filter — target rows only; source rows are always
  // included (the shared-source invariant). Absent = all lanes (unchanged).
  const qLane = url.searchParams.get("lane")
  if (qLane !== null && qLane.length > 64) {
    return new Response("invalid lane: must be 64 characters or fewer", { status: 400 })
  }
  const laneFilter = qLane && qLane.length > 0 ? qLane : null

  const qSince = url.searchParams.get("since")
  let since: number | null = null
  if (qSince !== null) {
    if (!/^\d+$/.test(qSince)) {
      return new Response("invalid since: must be a non-negative integer", { status: 400 })
    }
    since = Number(qSince)
  }

  // Pull every row for the file in one query — anchor-chain ordering is
  // computed in memory. A Bible file is ~30k cells per side ≈ a few MB of
  // text; pulling once and ordering is faster than emitting one query per
  // chain step. For very large files this could be paginated by anchor key,
  // but the v1 SLO target is "open a project, render cells" and the chain
  // walk dominates only at >10x current file sizes.
  const columns =
    "cell_id, side, target_lang, value, value_html, type, canonical_ref, anchor_cell_id, " +
    "event_id, source_event_id, last_editor, last_edit_at, validated, ai_drafted, word_count, " +
    "endorsement_count, start_ms, end_ms, " +
    "medium, sequence_index, transcription, camera_state, metadata"

  // Per-cell fast path: when `cellIds=a,b,c` is present we skip chain walking
  // and just return matching rows. Used by the WS-triggered single-cell
  // revalidate path so a remote validate doesn't trigger a full file refetch.
  // Capped to keep this from being abused as a bulk read; legitimate WS
  // bursts coalesce to a handful of cells at most.
  const qCellIds = url.searchParams.get("cellIds")
  const cellIdsFilter = qCellIds
    ? qCellIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 100)
    : null

  // Conditional / delta machinery (audit M2-1). Skipped for the targeted
  // cellIds fast path, which stays exactly as it was. Both branches are
  // answered from the events log BEFORE the unbounded cells SELECT runs —
  // a 304 costs one MAX() query, a delta costs MAX() + a seq-range scan.
  //
  // Ordering note: the watermark is computed before the rows are read, so a
  // write landing in between yields rows NEWER than the advertised
  // maxServerSeq — the client's next `?since=` re-fetches those rows. Stale
  // in the safe direction, never the lossy one.
  let maxServerSeq: number | null = null
  let etag: string | null = null
  if (!cellIdsFilter || cellIdsFilter.length === 0) {
    const watermarks = await fetchWatermarks(env.AQUILLA_PG, projectId, fileId)
    maxServerSeq = advertisedSeq(watermarks)
    etag = makeEtag(fileId, watermarks)
    if (ifNoneMatchMatches(request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders(etag) })
    }
    if (since !== null) {
      // Rebuild gate (audit B5): a projection rebuild changed cells without
      // minting events, so the seq-range delta below cannot see it. Any
      // cursor minted before the rebuild finished predates rebuiltSeq —
      // hand back the same resync marker the >limit branch uses and let the
      // client fall back to a full stream.
      if (since < watermarks.rebuiltSeq) {
        return Response.json({ resync: true, maxServerSeq }, { headers: cacheHeaders(etag) })
      }
      // Cells touched by any event past the cursor. cell_id IS NULL events
      // (file.rename, project-scoped) bump the watermark but change no rows.
      // idx_events_project_seq makes the seq-range scan cheap when `since`
      // is recent — the overwhelmingly common case (focus / post-commit).
      const changedRes = await env.AQUILLA_PG.prepare(
        "SELECT DISTINCT cell_id FROM events WHERE project_id = ? AND file_id = ? AND server_seq > ? AND cell_id IS NOT NULL",
      )
        .bind(projectId, fileId, since)
        .all<{ cell_id: string }>()
      const changedCellIds = changedRes.results.map((r) => r.cell_id)
      if (changedCellIds.length > DELTA_RESYNC_LIMIT) {
        return Response.json({ resync: true, maxServerSeq }, { headers: cacheHeaders(etag) })
      }
      let deltaRows: CellRowRaw[] = []
      if (changedCellIds.length > 0) {
        const placeholders = changedCellIds.map(() => "?").join(", ")
        const deltaParts = [
          `SELECT ${columns}`,
          "FROM cells",
          `WHERE project_id = ? AND file_id = ? AND cell_id IN (${placeholders})`,
        ]
        const deltaBinds: unknown[] = [projectId, fileId, ...changedCellIds]
        if (sideFilter !== null) {
          deltaParts.push("AND side = ?")
          deltaBinds.push(sideFilter)
        }
        if (laneFilter !== null) {
          deltaParts.push("AND (side = 'source' OR target_lang = ?)")
          deltaBinds.push(laneFilter)
        }
        const deltaRes = await env.AQUILLA_PG.prepare(deltaParts.join(" "))
          .bind(...deltaBinds)
          .all<CellRowRaw>()
        deltaRows = deltaRes.results
      }
      // No chain-walk: delta rows carry their anchor pointers and the client
      // re-walks the merged set, so order here is irrelevant. A changed
      // cellId with no row below was deleted (or is side-filtered out).
      return Response.json(
        {
          delta: true,
          changedCellIds,
          cells: deltaRows.map(mapRow),
          maxServerSeq,
        },
        { headers: cacheHeaders(etag) },
      )
    }
  }

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
  if (laneFilter !== null) {
    parts.push("AND (side = 'source' OR target_lang = ?)")
    binds.push(laneFilter)
  }
  const sql = parts.join(" ")

  const result = await env.AQUILLA_PG.prepare(sql).bind(...binds).all<CellRowRaw>()
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
    //
    // AQU-538: the walk dedupes by cell_id, so N target lanes for the same
    // cell must be walked PER LANE or sibling-lane rows silently drop.
    // Default lane ('') first, then added lanes in name order — for N=1
    // (only '' exists) the output is byte-identical to the pre-lane walk.
    const sourceRows: CellRowRaw[] = []
    const targetByLane = new Map<string, CellRowRaw[]>()
    for (const r of allRows) {
      if (r.side === "source") sourceRows.push(r)
      else if (r.side === "target") {
        const lane = r.target_lang ?? ""
        let bucket = targetByLane.get(lane)
        if (!bucket) {
          bucket = []
          targetByLane.set(lane, bucket)
        }
        bucket.push(r)
      }
    }
    ordered = walkAnchorChain(sourceRows)
    for (const lane of [...targetByLane.keys()].sort()) {
      ordered = [...ordered, ...walkAnchorChain(targetByLane.get(lane)!)]
    }
  } else if (sideFilter === "target") {
    // Same per-lane walk for target-only reads.
    const byLane = new Map<string, CellRowRaw[]>()
    for (const r of allRows) {
      const lane = r.target_lang ?? ""
      let bucket = byLane.get(lane)
      if (!bucket) {
        bucket = []
        byLane.set(lane, bucket)
      }
      bucket.push(r)
    }
    ordered = []
    for (const lane of [...byLane.keys()].sort()) {
      ordered = [...ordered, ...walkAnchorChain(byLane.get(lane)!)]
    }
  } else {
    ordered = walkAnchorChain(allRows)
  }

  const offset = cursor?.offset ?? 0
  const slice = ordered.slice(offset, offset + limit)
  const nextOffset = offset + slice.length
  const hasMore = nextOffset < ordered.length

  return Response.json(
    {
      cells: slice.map(mapRow),
      nextCursor: hasMore ? encodeCursor({ offset: nextOffset }) : null,
      total: ordered.length,
      // Null only on the cellIds fast path, which skips the watermark query.
      maxServerSeq,
    },
    etag !== null ? { headers: cacheHeaders(etag) } : undefined,
  )
}
