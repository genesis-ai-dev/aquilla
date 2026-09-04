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
//                         rebuild changed cells without minting events), or
//                         belongs to a previous incarnation of the project
//                         (AQU-943) — the response is `{ resync: true,
//                         maxServerSeq, projectEpoch }` and the client falls
//                         back to a full stream.
//   epoch=<projectEpoch> — AQU-943: the incarnation the client's `?since=`
//                         cursor was minted against, echoed from the
//                         `projectEpoch` it was handed with that cursor. A
//                         mismatch against the project's current epoch forces
//                         a resync. Omitted by pre-AQU-943 clients, which
//                         leaves their behavior unchanged.
//
// Conditional reads: every non-cellIds response carries
// `ETag: "<fileId>:<epoch>:<rebuiltSeq>:<maxSeq>"` where maxSeq =
// MAX(server_seq) over the file's events, rebuiltSeq is the project's rebuild
// marker (project_seq_counters.rebuilt_seq, 0 if never rebuilt) and epoch is
// its incarnation marker (project_seq_counters.project_epoch, 0 if the project
// has no counter row) — all strictly ordering/identity keys, NEVER counts
// (server_seq has harmless gaps from idempotent replays). A request with a
// matching `If-None-Match` returns 304 before any cells row is read. Full
// (non-delta) responses additionally carry `maxServerSeq` (= GREATEST of the
// seq pair) and `projectEpoch` in the JSON body so cross-origin clients can
// build their next `?since=`/`?epoch=` cursor without reading response headers.
//
// Incarnation (AQU-943): wiping a project's rows and re-migrating it under the
// same deterministic ids restarts the seq allocator, so a warm client's cursor
// can sit ABOVE the whole new history and every delta answers "nothing newer".
// The epoch — stamped when the seq-counter row is created — is what makes that
// visible; see the gates in the `since` branch below.
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
import type { AiDraftProvenance } from "./types"
import { PENDING_ALLOC_TTL_MS } from "./event-insert"

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
 * side) are appended at the tail: each orphan ROOT in event_id order with
 * its own sub-chain walked behind it (AQU-931 — a dangling anchor must not
 * scatter the cells that still chain together), then any cycle remnants
 * flat in event_id order — they'd otherwise drop out entirely, which is
 * the wrong default for a read API that should surface everything in the
 * projection.
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
  const byEventId = (a: CellRowRaw, b: CellRowRaw): number =>
    a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0

  // Depth-first descent. Each cell's id becomes the anchor key for the next
  // layer. We process siblings in ascending event_id order: the first
  // sibling's whole sub-chain is emitted before moving to the next sibling.
  // Iterative to avoid stack overflow on Bible-sized files (~30k cells per
  // side).
  //
  // The stack carries (anchorKey, indexIntoChildren) frames so we can
  // resume after recursing into a child. Visiting a child appends it to
  // `ordered` and pushes a new frame for its descendants.
  type Frame = { key: string; i: number }
  const descend = (rootKey: string): void => {
    const stack: Frame[] = [{ key: rootKey, i: 0 }]
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
  }
  descend("") // "" = null anchor (head)

  // Orphan ROOTS: cells whose anchor points to a non-existent cell on this
  // side (a retracted heading/milestone — AQU-931). Flat-appending every
  // unreachable row would scatter whole sub-chains in event_id (effectively
  // random) order, because a dangling anchor strands not just the cell but
  // everything chained behind it. Instead, promote each orphan root in
  // event_id order and walk its descendants, so runs that still chain
  // together stay contiguous behind their orphaned head.
  if (visited.size < rows.length) {
    const roots: CellRowRaw[] = []
    for (const r of rows) {
      if (visited.has(r.cell_id)) continue
      if (r.anchor_cell_id !== null && !cellIds.has(r.anchor_cell_id)) roots.push(r)
    }
    roots.sort(byEventId)
    for (const root of roots) {
      if (visited.has(root.cell_id)) continue
      visited.add(root.cell_id)
      ordered.push(root)
      descend(root.cell_id)
    }
  }

  // Cycle remnants: anchor resolves to a known cell yet the walk never
  // reached them (a malformed projection). Stable flat order by event_id —
  // they'd otherwise drop out entirely, which is the wrong default for a
  // read API that should surface everything in the projection.
  if (visited.size < rows.length) {
    const orphans: CellRowRaw[] = []
    for (const r of rows) {
      if (!visited.has(r.cell_id)) orphans.push(r)
    }
    orphans.sort(byEventId)
    ordered.push(...orphans)
  }

  return ordered
}

interface Cursor {
  /** Index into the ordered chain to resume from. */
  offset: number
}

// ─── AQU-1160: ordered-id chain cache ───────────────────────────────────────
//
// The full-file read + in-memory anchor-chain walk above is O(file size) —
// correct (it's the tested oracle every fallback below defers to) but a
// 500-row page on a 30k-cell file paid the cost of materializing and walking
// every row on EVERY page. This cache breaks that: the FIRST page request for
// a given (project, file, side, lane, ETag) still pays the full walk (there's
// no way around computing the order at least once without a persisted
// position column — a bigger change than this ticket takes on, see the
// SWARM-TODO in the PR/issue comment), but it remembers the resulting
// ORDERED LIST OF IDS (not the row data — cheap, ~40 bytes/id) so every
// subsequent page for the same version is a single bounded
// `(side, target_lang, cell_id) IN (...)` point lookup sized to the page,
// served by idx_cells_file_scan (0083_cells_scan_index.sql).
//
// Keyed by the response ETag: that string is already the exact "identity of
// current full state" value this route computes for conditional reads
// (fileId + epoch + rebuiltSeq + maxSeq — see makeEtag), so any write that
// would change ordering, add/remove/change a row, or rebuild/re-incarnate the
// project changes the key and the cache misses safely. Never used for the
// `cellIds=` fast path (unpaginated, order is the caller's request order) or
// the `since=` delta path (unordered by design).
//
// Isolate-local only (no DO/KV): correctness never depends on a hit, so a
// cold isolate or eviction just falls back to the full walk — see the
// SWARM-TODO for the isolate-hit-rate caveat this implies for the very first
// page of a newly-opened file.
interface ChainCacheItem {
  cellId: string
  side: "source" | "target"
  targetLang: string
}

interface ChainCacheEntry {
  items: ChainCacheItem[]
  cachedAt: number
}

const CHAIN_CACHE_MAX_ENTRIES = 8
const CHAIN_CACHE_TTL_MS = 10 * 60 * 1000

// Scoped per AquillaDb instance via a WeakMap rather than one flat module
// singleton: `fileId` alone is not a safe cross-project cache key (nothing
// enforces global fileId uniqueness at this layer -- the route always scopes
// its queries by project_id + file_id together), so the key below also
// includes `projectId`, and the outer WeakMap keeps state from leaking
// across unrelated AquillaDb bindings (e.g. isolated test databases in the
// same process -- two independent test cases both querying `proj-a`/`file-x`
// with no seeded events collided on the identical zero-watermark ETag when
// this was a bare module Map).
const chainCacheByDb = new WeakMap<AquillaDb, Map<string, ChainCacheEntry>>()

function chainCacheFor(db: AquillaDb): Map<string, ChainCacheEntry> {
  let cache = chainCacheByDb.get(db)
  if (!cache) {
    cache = new Map()
    chainCacheByDb.set(db, cache)
  }
  return cache
}

function chainCacheKey(
  projectId: string,
  etag: string,
  sideFilter: "source" | "target" | null,
  laneFilter: string | null,
): string {
  return `${projectId} ${etag} ${sideFilter ?? "*"} ${laneFilter ?? ""}`
}

function chainCacheGet(cache: Map<string, ChainCacheEntry>, key: string): ChainCacheEntry | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > CHAIN_CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  // Touch for recency: re-insert so Map's insertion-order iteration doubles
  // as a cheap LRU for the eviction below.
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

function chainCacheSet(cache: Map<string, ChainCacheEntry>, key: string, entry: ChainCacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CHAIN_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
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
  /** The project's incarnation marker (AQU-943): the stamp minted when the
   *  seq-counter row was created. 0 when the project has no counter row yet. */
  epoch: number
  /** AQU-1005 fence: one below the oldest live (unsettled, unexpired) seq
   *  allocation, null when nothing is pending. Clamps the ADVERTISED cursor
   *  only — delivery and the ETag stay on maxSeq, so a 304 can never strand
   *  a client: when the straggler commits, maxSeq moves, the ETag misses,
   *  and the delta from the clamped cursor re-covers the straggler's rows. */
  pendingFloor: number | null
}

/** The ETag / `?since=` watermark set, in one round-trip (every subquery is an
 *  indexed point/range read). `Number()` normalizes the BIGINTs, which
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
         (SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = ?) AS rebuilt_seq,
         (SELECT project_epoch FROM project_seq_counters WHERE project_id = ?) AS project_epoch,
         (SELECT MIN(first_seq) - 1 FROM seq_allocations
            WHERE project_id = ? AND created_at > now() - (? * interval '1 millisecond')) AS pending_floor`,
    )
    .bind(projectId, fileId, projectId, projectId, projectId, PENDING_ALLOC_TTL_MS)
    .first<{
      max_seq: number | string | bigint
      rebuilt_seq: number | string | bigint | null
      project_epoch: number | string | bigint | null
      pending_floor: number | string | bigint | null
    }>()
  return {
    maxSeq: Number(row?.max_seq ?? 0),
    // NULL when the project has no counter row yet (never wrote post-allocator,
    // never rebuilt) — behaves exactly as before the rebuild marker existed.
    rebuiltSeq: Number(row?.rebuilt_seq ?? 0),
    // NULL for the same reason. 0 = "no incarnation known"; a client can never
    // hold a cursor from a project that never allocated a seq, so the epoch
    // gate below is a no-op in that case rather than a forced resync.
    epoch: Number(row?.project_epoch ?? 0),
    // NULL when no writer is mid-flight — the overwhelmingly common case.
    pendingFloor: row?.pending_floor == null ? null : Number(row.pending_floor),
  }
}

/** rebuiltSeq is folded in so conditional reads MISS after a rebuild even
 *  though MAX(server_seq) did not move; epoch likewise so they MISS after the
 *  project was wiped and re-created under the same ids (AQU-943), where
 *  MAX(server_seq) can even move BACKWARDS. */
function makeEtag(fileId: string, w: Watermarks): string {
  return `"${fileId}:${w.epoch}:${w.rebuiltSeq}:${w.maxSeq}"`
}

/** The watermark advertised to clients as `maxServerSeq` (their next `?since=`
 *  cursor). Including rebuiltSeq is what terminates the resync: the full
 *  refetch hands back a cursor at/above the marker, so the client's next
 *  delta passes the `since < rebuiltSeq` gate instead of looping. Safe: no
 *  event at or below rebuiltSeq can ever be minted later (the rebuild bumped
 *  the allocator to it), so no delta is skipped. */
function advertisedSeq(w: Watermarks): number {
  const unclamped = Math.max(w.maxSeq, w.rebuiltSeq)
  return w.pendingFloor == null ? unclamped : Math.min(unclamped, w.pendingFloor)
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

  // AQU-943: the incarnation the client's `?since=` cursor was minted against
  // (the `projectEpoch` handed back with that cursor). Omitted by pre-AQU-943
  // clients, which keeps their behavior exactly as it was; the seq-inversion
  // gate below still catches the common restarted-allocator case for them.
  const qEpoch = url.searchParams.get("epoch")
  let clientEpoch: number | null = null
  if (qEpoch !== null) {
    if (!/^\d+$/.test(qEpoch)) {
      return new Response("invalid epoch: must be a non-negative integer", { status: 400 })
    }
    clientEpoch = Number(qEpoch)
  }

  // Pull every row for the file in one query — anchor-chain ordering is
  // computed in memory. A Bible file is ~30k cells per side ≈ a few MB of
  // text; pulling once and ordering is faster than emitting one query per
  // chain step. For very large files this could be paginated by anchor key,
  // but the v1 SLO target is "open a project, render cells" and the chain
  // walk dominates only at >10x current file sizes.
  const columns =
    "cell_id, side, target_lang, value, value_html, type, canonical_ref, anchor_cell_id, " +
    "event_id, source_event_id, last_editor, last_edit_at, validated, ai_drafted, ai_draft, word_count, " +
    "endorsement_count, start_ms, end_ms, " +
    "medium, sequence_index, transcription, camera_state, metadata"

  // Per-cell fast path: when `cellIds=a,b,c` is present we skip chain walking
  // and just return matching rows. Used by the WS-triggered single-cell
  // revalidate path so a remote validate doesn't trigger a full file refetch.
  // Capped to keep this from being abused as a bulk read; legitimate WS
  // bursts coalesce to a handful of cells at most.
  const qCellIds = url.searchParams.get("cellIds")
  const cellIdsFilter = qCellIds
    ? qCellIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : null
  if (cellIdsFilter && cellIdsFilter.length > 100) {
    return new Response("too many cellIds: maximum is 100 per request", { status: 400 })
  }

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
  let projectEpoch: number | null = null
  let etag: string | null = null
  if (!cellIdsFilter || cellIdsFilter.length === 0) {
    const watermarks = await fetchWatermarks(env.AQUILLA_PG, projectId, fileId)
    maxServerSeq = advertisedSeq(watermarks)
    projectEpoch = watermarks.epoch
    etag = makeEtag(fileId, watermarks)
    if (ifNoneMatchMatches(request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders(etag) })
    }
    if (since !== null) {
      // The resync gate must use the UNCLAMPED max: a pending-allocation
      // clamp can legitimately sit BELOW a cursor the client already holds
      // from an earlier response, and that is not incarnation drift.
      const unclampedMax = Math.max(watermarks.maxSeq, watermarks.rebuiltSeq)
      // Rebuild gate (audit B5): a projection rebuild changed cells without
      // minting events, so the seq-range delta below cannot see it. Any
      // cursor minted before the rebuild finished predates rebuiltSeq —
      // hand back the same resync marker the >limit branch uses and let the
      // client fall back to a full stream.
      //
      // Incarnation gates (AQU-943): a project wiped and re-migrated under the
      // same deterministic ids restarts the seq allocator, so a warm client's
      // cursor points into a seq range that no longer means anything. Two
      // independent signals, both answering with the same resync marker:
      //
      //  1. Epoch mismatch — the client told us which incarnation minted its
      //     cursor and it isn't this one. Exact, and the only signal that
      //     survives a re-migration whose seq range OVERLAPS the old one.
      //     Skipped when either side is 0 (pre-AQU-943 client, or a project
      //     that has never allocated a seq — no cursor can exist for it).
      //  2. Seq inversion — the cursor sits ABOVE everything this project can
      //     currently advertise. Only a restarted allocator (or a hard event
      //     delete, which wants the same resync) can produce that, since
      //     server_seq is monotonic within an incarnation. Costs nothing and
      //     rescues pre-AQU-943 clients that send no epoch at all.
      //
      // The rebuild branch is additionally fenced by the ADVERTISED (clamped)
      // value (AQU-1005): when a live allocation predates the rebuild, the
      // pending floor sits BELOW rebuiltSeq, so the cursor we hand out would
      // itself fail `since < rebuiltSeq` — every client in the project would
      // full-refetch on every poll until the allocation settles. A cursor at
      // or above what we are currently advertising therefore never trips the
      // rebuild resync. Accepted cost: a stale pre-rebuild client whose cursor
      // happens to land in [pendingFloor, rebuiltSeq) sees pre-rebuild cell
      // state for at most PENDING_ALLOC_TTL_MS; when the floor lifts it gets
      // exactly one final resync and self-heals.
      if (
        (since < watermarks.rebuiltSeq && since < advertisedSeq(watermarks)) ||
        (clientEpoch !== null &&
          clientEpoch !== 0 &&
          watermarks.epoch !== 0 &&
          clientEpoch !== watermarks.epoch) ||
        since > unclampedMax
      ) {
        return Response.json(
          { resync: true, maxServerSeq, projectEpoch: watermarks.epoch },
          { headers: cacheHeaders(etag) },
        )
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
        return Response.json(
          { resync: true, maxServerSeq, projectEpoch },
          { headers: cacheHeaders(etag) },
        )
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
          projectEpoch,
        },
        { headers: cacheHeaders(etag) },
      )
    }
  }

  // AQU-1160: cache applies only to the paginated whole-file/whole-side walk
  // — never to the targeted cellIds fast path (already bounded, order is the
  // caller's request order) and only when the watermark/ETag was computed
  // (i.e. cellIdsFilter is empty, same gate as the delta branch above).
  const useChainCache = etag !== null && (!cellIdsFilter || cellIdsFilter.length === 0)
  const dbChainCache = useChainCache ? chainCacheFor(env.AQUILLA_PG) : null
  const cacheKey = useChainCache ? chainCacheKey(projectId, etag!, sideFilter, laneFilter) : null
  const cached = dbChainCache && cacheKey ? chainCacheGet(dbChainCache, cacheKey) : null

  if (cached) {
    const offset = cursor?.offset ?? 0
    const pageItems = cached.items.slice(offset, offset + limit)
    const nextOffset = offset + pageItems.length
    const hasMore = nextOffset < cached.items.length

    let cells: CellRowOut[] = []
    if (pageItems.length > 0) {
      // Bounded point lookup: exactly the page's rows, served by
      // idx_cells_file_scan (project_id, file_id, side, target_lang, cell_id)
      // — independent of file size (AQU-1160 AC1).
      const tuples = pageItems.map(() => "(?, ?, ?)").join(", ")
      const pageParts = [
        `SELECT ${columns}`,
        "FROM cells",
        "WHERE project_id = ? AND file_id = ?",
        `AND (side, target_lang, cell_id) IN (${tuples})`,
      ]
      const pageBinds: unknown[] = [projectId, fileId]
      for (const item of pageItems) pageBinds.push(item.side, item.targetLang, item.cellId)
      const pageRes = await env.AQUILLA_PG
        .prepare(pageParts.join(" "))
        .bind(...pageBinds)
        .all<CellRowRaw>()
      // Evidence for AQU-1160 AC1: a page read touches exactly the page's
      // rows, not the file. Compare against the cache-miss row-count log
      // below (which logs `allRows.length`, the pre-AQU-1160 full-file cost).
      console.log(
        `[cells-read] chain-cache hit file=${fileId} rows=${pageRes.results.length} page=${pageItems.length} totalOrdered=${cached.items.length}`,
      )
      const bySlot = new Map<string, CellRowRaw>()
      for (const r of pageRes.results) bySlot.set(`${r.side} ${r.target_lang ?? ""} ${r.cell_id}`, r)
      cells = []
      for (const item of pageItems) {
        const row = bySlot.get(`${item.side} ${item.targetLang} ${item.cellId}`)
        if (row) cells.push(mapRow(row))
      }
    }

    return Response.json(
      {
        cells,
        nextCursor: hasMore ? encodeCursor({ offset: nextOffset }) : null,
        total: cached.items.length,
        maxServerSeq,
        projectEpoch,
      },
      { headers: cacheHeaders(etag!) },
    )
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
  if (useChainCache) {
    // Evidence for AQU-1160 AC1's baseline: this is the pre-cache, full-file
    // cost every page paid before this change. Compare against the
    // chain-cache hit log above.
    console.log(`[cells-read] chain-cache miss file=${fileId} rows=${allRows.length}`)
  }

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

  if (dbChainCache && cacheKey) {
    chainCacheSet(dbChainCache, cacheKey, {
      items: ordered.map((r) => ({ cellId: r.cell_id, side: r.side, targetLang: r.target_lang ?? "" })),
      cachedAt: Date.now(),
    })
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
      // AQU-943: the incarnation this page's cursor belongs to. The client
      // stores it beside the cursor and echoes it as `?epoch=` on its next
      // delta, so a wipe + re-create is caught even when the new seq range
      // overlaps the old one.
      projectEpoch,
    },
    etag !== null ? { headers: cacheHeaders(etag) } : undefined,
  )
}
