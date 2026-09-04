// HTTP fetch handler for POST /events — the AD-2 event ingestion endpoint.
//
// For each event in the request body:
//   1. authorize() — JWT scope + role gate.
//   2. Idempotency: if an event with this id already exists, accept and skip.
//   3. Assign server_ts (Date.now()) and server_seq (per-project monotonic).
//   4. Evaluate the AD-2 first-child-of-parent guard. The event always
//      lands in `events` (so history can surface it); only the projection
//      writes are skipped for stale siblings.
//   5. Dispatch to the kind-specific handler to build SQL statements.
//   6. Batch-commit in BATCH_LIMIT chunks.
//   7. Broadcast realtime frames + projection.dirty messages.
//
// Auth: Authorization: Bearer <sync-token JWT> (same token used for WS upgrades).
//       Each event is authorized independently so a single bad event doesn't
//       tank the whole batch.
//
// Idempotent: event.id is a client-generated UUIDv7. The events INSERT uses
//   INSERT OR IGNORE, so replaying a batch with the same IDs is safe. The
//   parent-chain guard is naturally idempotent — replaying the winning
//   event sees its own row as the existing one and continues to win.

import type { RawEvent } from './types'
import type { RealtimeMessage, ProjectionTable } from './realtime'
import { authorize } from './authorize'
import { dispatchEvent, type DispatchOutcome } from './dispatch'
import { allocateSeqRange, buildSettleSeqRangeStmt } from './event-insert'
import { CELL_ROW_COLUMNS, mapCellRow, type CellRowOut, type CellRowRaw } from './cell-row-serialize'
import {
  CHAIN_MUTATING_KINDS,
  fileCountersRecomputeStmt,
  isChainArbitrated,
  isChainMutatingKind,
  laneOfEvent,
  type PersistedEvent,
} from './event-projection'
import {
  GENESIS_PARENT_KEY,
  eventQualifiedParentKey,
  qualifyParentKeyBase,
  slotKey,
  type ChainSlot,
} from './chain-claims'
import { broadcastRealtime } from './broadcast'
import type { BroadcastEnv } from './broadcast'
import { checkProjectMembership, type MembershipCheck } from './membership'
import { ROLE, isForeignCommentKind, requiredRoleForForeignComment, roleLabel } from './role-policy'
import { sendCommentNotifications, type EmailService } from '../notification-email'
import { laneRelevantHeadSeq } from './link-sync'
import {
  fileProgressRecomputeStmt,
  fullProgressRecomputeStmts,
  sectionsProgressRecomputeStmt,
} from './progress-projection'
import { makeRequestCache } from './request-cache'

// Max statements per batch() transaction — a conservative self-imposed cap (Postgres has no hard limit; keeps any single transaction bounded).
const BATCH_LIMIT = 100

// Max events accepted in a single request. The outbox flusher caps its own
// batches at 100 (src/lib/sync/outbox-flush.ts MAX_BATCH) — this is 5x
// headroom for legitimate traffic while stopping an oversized/malicious body
// from fanning out into an unbounded number of prefetch reads and Postgres
// batch() calls within one request/transaction against the shared Neon
// primary (via Hyperdrive) — long-running or connection-pool-exhausting
// transactions degrade every other project sharing it, not just this one.
const MAX_EVENTS_PER_REQUEST = 500

// ── FRO-479 push accelerator: notify live downstreams of upstream commits ──
//
// Hard constraint (spec §8): push is a LOSSY ACCELERATOR, never load-bearing.
// The FRO-476 mirror sync (lazy-pull on file open, `POST /link/sync`) is the
// deterministic self-healing floor — this hook only shaves the "next open"
// wait down to "seconds" for downstreams that are already connected. It must
// never perform an eager fan-out WRITE on the upstream commit path (no events
// minted here, no DB writes) and must never be awaited before the response.
//
// Lane-relevant kinds mirror `LANE_KINDS_SOURCE` in link-sync.ts (not
// exported there — re-declared per the FRO-479 dispatch note rather than
// touching a forbidden file). Comments/audio/BT/validation events on a
// consumes=source link never mirror, so they must never produce a frame —
// a probe/notify that counted them would make every downstream "blink" on
// unrelated upstream noise.
const LINK_NOTIFY_LANE_KINDS: ReadonlySet<string> = new Set([
  'source.cell.create',
  'source.cell.commit',
  'source.cell.delete',
  'source.cell.mirror',
  'cell.retime',
  'cast.assign',
  'file.create',
])

/** Per-commit cap on distinct cell ids carried in the frame (spec §8: "capped
 *  at 64"). The rest converge lazily via the mirror sync's own delta fold —
 *  this is a hint for a targeted client refetch, not the source of truth. */
const LINK_NOTIFY_CELL_ID_CAP = 64

/** Per-commit cap on the number of downstream projects notified. At scale
 *  (spec: up to 600 downstreams) the rest converge lazily on next file open;
 *  notifying is strictly best-effort so under-notifying is safe. */
const LINK_NOTIFY_DOWNSTREAM_CAP = 50

/** How long a project's downstream list is cached in-isolate before being
 *  re-queried (spec §8: "cached in-memory per isolate with short TTL"). Link
 *  creation/detach is a rare admin action, so a short window trades a little
 *  staleness on the notify path (never load-bearing) for avoiding a query on
 *  every single commit. */
const LINK_NOTIFY_DOWNSTREAM_CACHE_TTL_MS = 30_000

interface DownstreamCacheEntry {
  downstreamIds: string[]
  expiresAt: number
}

// Isolate-lifetime cache — module scope is intentional (mirrors the pattern
// already used for per-isolate memoization elsewhere in this worker). Keyed
// by upstream project id.
const downstreamCache = new Map<string, DownstreamCacheEntry>()

/** Test-only escape hatch: the cache is module-scoped (isolate lifetime) by
 *  design, which otherwise leaks state between test cases running in the
 *  same vitest module instance. Not used by production code paths. */
export function __resetLinkNotifyDownstreamCacheForTests(): void {
  downstreamCache.clear()
}

/**
 * Live (non-clone) downstreams of `upstreamProjectId`. Clone-mode downstreams
 * never receive push frames (spec: "Clone-mode downstreams receive no
 * frames") — they have no mirror sync to trigger and no staleness to refetch.
 */
async function loadLiveDownstreams(
  db: AquillaDb,
  upstreamProjectId: string,
  now: number,
): Promise<string[]> {
  const cached = downstreamCache.get(upstreamProjectId)
  if (cached && cached.expiresAt > now) return cached.downstreamIds

  const { results } = await db
    .prepare(
      `SELECT id FROM projects
       WHERE source_project_id = ?
         AND source_link_mode IS NOT NULL
         AND source_link_mode != 'clone'`,
    )
    .bind(upstreamProjectId)
    .all<{ id: string }>()

  const downstreamIds = results.map((r) => r.id)
  downstreamCache.set(upstreamProjectId, {
    downstreamIds,
    expiresAt: now + LINK_NOTIFY_DOWNSTREAM_CACHE_TTL_MS,
  })
  return downstreamIds
}

/**
 * Send `link.upstream-changed` frames to every live downstream of every
 * project that just committed lane-relevant events in this request. Called
 * via `ctx.waitUntil` AFTER the response is built (see call site) — never
 * awaited in the request path, so downstream count can never regress
 * upstream commit latency (spec acceptance criterion).
 *
 * `committed` is grouped by upstream (project that committed), each with
 * the lane-relevant file/cell ids touched.
 */
async function notifyLiveDownstreamsOfUpstreamChanges(
  db: AquillaDb,
  projectSync: DurableObjectNamespace,
  secretKey: string,
  committed: ReadonlyMap<string, { fileIds: Set<string>; cellIds: Set<string> }>,
): Promise<void> {
  const now = Date.now()
  const sends: Promise<void>[] = []

  for (const [upstreamProjectId, delta] of committed) {
    let downstreamIds: string[]
    try {
      downstreamIds = await loadLiveDownstreams(db, upstreamProjectId, now)
    } catch (err) {
      console.warn('[events/route] link-notify: downstream lookup failed:', err)
      continue
    }
    if (downstreamIds.length === 0) continue

    // Advisory only — the client never gates on this value, it's an
    // audit-trail hint (spec §8). Reading it here (post-response, inside
    // waitUntil) costs nothing on the commit path.
    let untilSeq = 0
    try {
      untilSeq = await laneRelevantHeadSeq(db, upstreamProjectId)
    } catch (err) {
      console.warn('[events/route] link-notify: head-seq probe failed:', err)
    }

    const cellIds = [...delta.cellIds].slice(0, LINK_NOTIFY_CELL_ID_CAP)
    const fileIds = [...delta.fileIds]
    const notified = downstreamIds.slice(0, LINK_NOTIFY_DOWNSTREAM_CAP)

    for (const downstreamId of notified) {
      const frame = {
        t: 'link.upstream-changed',
        project: downstreamId,
        upstream: upstreamProjectId,
        untilSeq,
        fileIds,
        cellIds,
      }
      const id = projectSync.idFromName(downstreamId)
      const stub = projectSync.get(id)
      sends.push(
        stub
          .fetch('http://do.internal/__broadcast', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${secretKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(frame),
          })
          .then(async (res) => {
            if (!res.ok) {
              console.warn(
                `[events/route] link-notify broadcast failed for ${downstreamId}: HTTP ${res.status}`,
              )
            }
          })
          .catch((err) => {
            console.warn('[events/route] link-notify broadcast error:', err)
          }),
      )
    }
  }

  await Promise.all(sends)
}

/**
 * Cell-content kinds whose `event.applied` frame carries `serverSeq` + the
 * cell's current projected `rows`: the chain-mutating kinds (create / commit /
 * delete / reorder on either side) plus the validation pair, which flips
 * `cells.validated` without advancing the chain head.
 */
function isEventAppliedRowsKind(kind: string): boolean {
  return isChainMutatingKind(kind) || kind === 'cell.validate' || kind === 'cell.unvalidate'
}

/** Above this many distinct cells in one request, `rows` is omitted from every
 * frame (clients fall back to the by-ids refetch) — bounds the DO payload. */
export const EVENT_APPLIED_ROWS_MAX_CELLS = 200

function cellRowsKey(project: string, file: string, cell: string): string {
  return `${project}|${file}|${cell}`
}

/**
 * ONE query for the current projected rows of every cell touched by the
 * committed cell-content events. Returns null when nothing qualifies (no
 * SELECT runs) or when the request exceeded EVENT_APPLIED_ROWS_MAX_CELLS.
 * Rows for an event that lost its chain slot are still the cell's CURRENT
 * head — that is what the client should converge on.
 */
async function readEventAppliedRows(
  db: AquillaDb,
  entries: ReadonlyArray<{ eventFrame: { kind: string; project: string; file?: string; cell?: string } }>,
): Promise<Map<string, CellRowOut[]> | null> {
  const slots = new Map<string, [string, string, string]>()
  for (const { eventFrame: f } of entries) {
    if (!f.file || !f.cell || !isEventAppliedRowsKind(f.kind)) continue
    slots.set(cellRowsKey(f.project, f.file, f.cell), [f.project, f.file, f.cell])
  }
  if (slots.size === 0) return null
  if (slots.size > EVENT_APPLIED_ROWS_MAX_CELLS) {
    console.warn(
      `[events/route] event.applied rows omitted: ${slots.size} cells > ${EVENT_APPLIED_ROWS_MAX_CELLS} cap`,
    )
    return null
  }
  const tuples = [...slots.values()]
  const placeholders = tuples.map(() => '(?, ?, ?)').join(', ')
  const out = new Map<string, CellRowOut[]>()
  try {
    const result = await db
      .prepare(
        `SELECT ${CELL_ROW_COLUMNS}, project_id, file_id FROM cells WHERE (project_id, file_id, cell_id) IN (${placeholders})`,
      )
      .bind(...tuples.flat())
      .all<CellRowRaw & { project_id: string; file_id: string }>()
    for (const raw of result.results) {
      const key = cellRowsKey(raw.project_id, raw.file_id, raw.cell_id)
      const bucket = out.get(key)
      const mapped = mapCellRow(raw)
      if (bucket) bucket.push(mapped)
      else out.set(key, [mapped])
    }
  } catch (err) {
    // Best-effort: without rows the client refetches exactly as before.
    console.warn('[events/route] event.applied rows read failed:', err)
    return null
  }
  return out
}

export interface EventsRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  /** Optional — when present, successful DB commits broadcast Realtime frames. */
  FileSync?: DurableObjectNamespace
  /** Optional — when present, successful DB commits fan-out event.applied frames
   * to connected WebSocket clients via the per-project ProjectSync DO. */
  ProjectSync?: DurableObjectNamespace
  /** Optional — when present (deployed envs), outbound notification emails are
   * sent on comment.create via the Cloudflare Email Service `send_email` binding. */
  EMAIL?: EmailService
  EMAIL_FROM?: string
  /** Base URL for deep links in notification emails (e.g. https://aquilla.app). */
  BASE_URL?: string
}

interface AcceptedEntry {
  id: string
}

interface RejectedEntry {
  id: string
  status: number
  reason: string
}

interface StaleSourceEntry {
  id: string
  currentSourceEventId: string
}

/**
 * Stale-sibling response entry. Carries `fileId` and `cellId` (when known —
 * always set for chain-mutating cell events, which are the only events that
 * can be flagged stale) so the client can navigate the user from the
 * stale-sibling banner directly to the cell's history drawer.
 */
interface StaleEntry {
  id: string
  fileId: string | null
  cellId: string | null
}

// ── Request-scoped prefetches (PERF-2) ─────────────────────────────────────
// The per-event loop used to issue 1–3 serial SELECTs per event (idempotency,
// AD-2 chain pre-check, F5 source pin, foreign-comment ownership,
// self-validation last-editor) — ~2N+ Hyperdrive round-trips per flush. All
// of these reads see only state committed BEFORE this request (pending
// statements commit after the loop), so hoisting them into one batched
// SELECT per concern is semantics-preserving. The only window that moves is
// against concurrent EXTERNAL writers, which the pre-checks never arbitrated
// anyway — the in-transaction chain claim (chain-claims.ts) does.

/** Which of `ids` already exist in `events` — one SELECT per request. */
async function readExistingEventIds(
  db: AquillaDb,
  ids: ReadonlySet<string>,
): Promise<Set<string>> {
  const found = new Set<string>()
  if (ids.size === 0) return found
  const list = [...ids]
  const placeholders = list.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT id FROM events WHERE id IN (${placeholders})`)
    .bind(...list)
    .all<{ id: string }>()
  for (const r of results) found.add(r.id)
  return found
}

/** A (project, file, cell) triple for the batched prefetches. */
interface CellKey {
  projectId: string
  fileId: string
  cellId: string
}

function cellKeyOf(projectId: string, fileId: string, cellId: string): string {
  return `${projectId}\0${fileId}\0${cellId}`
}

/**
 * Batched equivalent of `isWinningChild` (event-projection.ts): the earliest
 * committed chain-mutating sibling per AD-2 slot, for every cell touched by
 * this request, in ONE SELECT. Keyed by `slotKey()` with the SAME side/lane-
 * qualified parent key the claim insert and isWinningChild use; a candidate
 * wins its slot iff the slot is absent or maps to the candidate's own id
 * (idempotent replay).
 *
 * Qualification runs in JS (payload is TEXT — no portable jsonb cast), so the
 * SQL window ranks within the UNQUALIFIED (cell, parent) slot and returns the
 * first 100 rows per slot for JS to split by side/lane — mirroring the
 * per-event isWinningChild's LIMIT 100. A truncated scan can only produce a
 * false "winner"; the atomic chain_claims gate remains authoritative for
 * in-flight races.
 *
 * Regression note: this prefetch originally kept the SQL's unqualified rn=1
 * winner, silently re-introducing the pre-AQU-538 arbitration for the whole
 * route — the second lane's first commit (or a source correction after a
 * target commit) shares its parent with an earlier sibling in another
 * namespace, lost the slot, and was dead-lettered as stale.
 */
async function prefetchChainWinners(
  db: AquillaDb,
  cells: readonly CellKey[],
): Promise<Map<string, string>> {
  const winners = new Map<string, string>()
  if (cells.length === 0) return winners

  const kindList = [...CHAIN_MUTATING_KINDS].map((k) => `'${k}'`).join(', ')
  const placeholders = cells.map(() => '(?, ?, ?)').join(', ')
  const binds: unknown[] = []
  for (const c of cells) binds.push(c.projectId, c.fileId, c.cellId)

  const { results } = await db
    .prepare(
      `SELECT id, project_id, file_id, cell_id, parent_key, kind, payload, server_seq FROM (
         SELECT id, project_id, file_id, cell_id, kind, payload, server_seq,
                COALESCE(parent_id, '${GENESIS_PARENT_KEY}') AS parent_key,
                ROW_NUMBER() OVER (
                  PARTITION BY project_id, file_id, cell_id,
                               COALESCE(parent_id, '${GENESIS_PARENT_KEY}')
                  ORDER BY server_seq ASC, id ASC
                ) AS rn
         FROM events
         WHERE kind IN (${kindList})
           AND (project_id, file_id, cell_id) IN (${placeholders})
       ) ranked
       WHERE rn <= 100`,
    )
    .bind(...binds)
    .all<{
      id: string
      project_id: string
      file_id: string
      cell_id: string
      parent_key: string
      kind: string
      payload: string
      server_seq: number
    }>()

  // Reduce to the earliest (server_seq, id) row per QUALIFIED slot. Rows
  // arrive grouped per unqualified slot but interleaved across slots, so the
  // min is tracked explicitly rather than relying on scan order.
  const best = new Map<string, { id: string; serverSeq: number }>()
  for (const r of results) {
    let payload: unknown = null
    try {
      payload = JSON.parse(r.payload)
    } catch {
      // Invalid historical payloads cannot qualify a named target lane, but
      // still arbitrate deterministically in their side/default namespace
      // (same policy as isWinningChild).
    }
    const key = slotKey({
      projectId: r.project_id,
      fileId: r.file_id,
      cellId: r.cell_id,
      parentKey: qualifyParentKeyBase(r.parent_key, r.kind, payload),
    })
    const prev = best.get(key)
    if (!prev || r.server_seq < prev.serverSeq || (r.server_seq === prev.serverSeq && r.id < prev.id)) {
      best.set(key, { id: r.id, serverSeq: r.server_seq })
    }
  }
  for (const [key, row] of best) winners.set(key, row.id)
  return winners
}

/** Key of one `cells` row's chain head: (project, file, cell, side, lane). */
function headKeyOf(
  projectId: string,
  fileId: string,
  cellId: string,
  kind: string,
  payload: unknown,
): string {
  const side = kind.startsWith('source.') ? 'source' : 'target'
  return `${cellKeyOf(projectId, fileId, cellId)}\0${side}\0${laneOfEvent(kind, payload)}`
}

/**
 * Current `cells.event_id` per (project, file, cell, side, lane) for every
 * cell touched by a chain-mutating event in this request, in ONE SELECT.
 * Keyed by `headKeyOf()`. Drives (a) the AQU-1154 head compare-and-swap
 * pre-check and (b) the F5 stale-source pre-check (source side, lane '' —
 * advisory UX only: pinned commits are accepted + projected regardless; the
 * flag just drives the client's "source changed" banner).
 */
async function prefetchCellHeads(
  db: AquillaDb,
  cells: readonly CellKey[],
): Promise<Map<string, string>> {
  const heads = new Map<string, string>()
  if (cells.length === 0) return heads

  const placeholders = cells.map(() => '(?, ?, ?)').join(', ')
  const binds: unknown[] = []
  for (const c of cells) binds.push(c.projectId, c.fileId, c.cellId)

  const { results } = await db
    .prepare(
      `SELECT project_id, file_id, cell_id, side, target_lang, event_id FROM cells
       WHERE (project_id, file_id, cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{
      project_id: string
      file_id: string
      cell_id: string
      side: string
      target_lang: string
      event_id: string
    }>()

  for (const r of results) {
    heads.set(
      `${cellKeyOf(r.project_id, r.file_id, r.cell_id)}\0${r.side}\0${r.target_lang}`,
      r.event_id,
    )
  }
  return heads
}

/**
 * FRO-476 live-mode lock: which of `cells` are mirrored source rows
 * (`upstream_event_id IS NOT NULL`) in a project whose link is `live` —
 * these are read-only locally (edits belong upstream); `source.cell.commit`
 * on them is rejected below. Downstream-added cells (no upstream_event_id)
 * stay editable. One batched SELECT per request, joined to `projects` so a
 * clone-mode or unlinked project's cells are never locked even if they
 * happen to carry a stale upstream_event_id from a prior live link.
 */
async function prefetchLiveMirrorLocks(
  db: AquillaDb,
  cells: readonly CellKey[],
): Promise<Set<string>> {
  const locked = new Set<string>()
  if (cells.length === 0) return locked

  const placeholders = cells.map(() => '(?, ?, ?)').join(', ')
  const binds: unknown[] = []
  for (const c of cells) binds.push(c.projectId, c.fileId, c.cellId)

  const { results } = await db
    .prepare(
      `SELECT c.project_id, c.file_id, c.cell_id FROM cells c
       JOIN projects p ON p.id = c.project_id
       WHERE c.side = 'source'
         AND c.upstream_event_id IS NOT NULL
         AND p.source_link_mode = 'live'
         AND (c.project_id, c.file_id, c.cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{ project_id: string; file_id: string; cell_id: string }>()

  for (const r of results) {
    locked.add(cellKeyOf(r.project_id, r.file_id, r.cell_id))
  }
  return locked
}

/**
 * Author of each `comments` row named by `commentIds`, in ONE SELECT. Backs
 * the foreign-comment-ownership check (comment.edit/delete/resolve,
 * cell.unvalidate with targetUsername) that previously issued one SELECT
 * per event.
 */
async function prefetchCommentAuthors(
  db: AquillaDb,
  commentIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const authors = new Map<string, string>()
  if (commentIds.size === 0) return authors
  const list = [...commentIds]
  const placeholders = list.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT comment_id, author_id FROM comments WHERE comment_id IN (${placeholders})`)
    .bind(...list)
    .all<{ comment_id: string; author_id: string }>()
  for (const r of results) authors.set(r.comment_id, r.author_id)
  return authors
}

/**
 * `last_editor` of each target cell in `cells`, in ONE SELECT. Backs the
 * FRO-189 self-validation check (cell.validate with allowSelfValidation
 * disabled) that previously issued one SELECT per event. Fetched for every
 * cell.validate candidate regardless of the project's allowSelfValidation
 * setting — a superset read is cheap and the setting isn't known until the
 * per-event loop reads readProjectSettings (memoized separately).
 */
async function prefetchLastEditors(
  db: AquillaDb,
  cells: readonly CellKey[],
): Promise<Map<string, string | null>> {
  const editors = new Map<string, string | null>()
  if (cells.length === 0) return editors

  const placeholders = cells.map(() => '(?, ?, ?)').join(', ')
  const binds: unknown[] = []
  for (const c of cells) binds.push(c.projectId, c.fileId, c.cellId)

  const { results } = await db
    .prepare(
      `SELECT project_id, file_id, cell_id, last_editor FROM cells
       WHERE side = 'target' AND (project_id, file_id, cell_id) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{ project_id: string; file_id: string; cell_id: string; last_editor: string | null }>()

  for (const r of results) {
    editors.set(cellKeyOf(r.project_id, r.file_id, r.cell_id), r.last_editor)
  }
  return editors
}

/**
 * POST /events
 *
 * Body: { events: RawEvent[] }
 *
 * Returns:
 *   {
 *     accepted: [{ id: string }],
 *     rejected: [{ id: string, status: number, reason: string }]
 *   }
 *
 * Returns null if the URL doesn't match (chainable in the fetch dispatcher).
 *
 * `ctx` is optional — when provided, notification emails for comment.create
 * events are fired via ctx.waitUntil so they never block the response.
 */
export async function handleEventsWriteRequest(
  request: Request,
  env: EventsRouteEnv,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response | null> {
  // 1. URL match.
  const url = new URL(request.url)
  if (url.pathname !== '/events') return null

  // 2. Method must be POST.
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 })
  }

  // 3. Env binding validation.
  if (!env.SYNC_SECRET_KEY) {
    return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response('AQUILLA_PG binding not configured', { status: 500 })
  }

  const db = env.AQUILLA_PG

  // 4. Parse body.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('events' in body)
  ) {
    return new Response('body must be an object with an "events" key', { status: 400 })
  }

  const rawBody = body as Record<string, unknown>
  if (!Array.isArray(rawBody.events)) {
    return new Response('"events" must be an array', { status: 400 })
  }

  const rawEvents = rawBody.events as RawEvent[]

  if (rawEvents.length === 0) {
    return Response.json({ accepted: [], rejected: [] })
  }
  if (rawEvents.length > MAX_EVENTS_PER_REQUEST) {
    return Response.json(
      {
        error: `too many events in one request (${rawEvents.length} > ${MAX_EVENTS_PER_REQUEST})`,
      },
      { status: 413 },
    )
  }

  // 5. Token extraction.
  const authHeader = request.headers.get('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  // Server time base — Date.now() incremented monotonically so two commits
  // in the same request can't share a server_ts. Server_seq is the
  // canonical ordering key, but human-readable timestamps still benefit
  // from monotonicity within a batch.
  let nextServerTs = Date.now()

  // AQU-1005: allocate every server_seq this request could need in ONE
  // autocommit statement, BEFORE any write transaction opens. The per-project
  // counter row lock is therefore held for microseconds instead of for the
  // whole event batch (the lock convoy), and the `seq_allocations` ledger row
  // fences readers' advertised `?since=` cursor below this block until it is
  // settled (or expires after PENDING_ALLOC_TTL_MS).
  //
  // Count comes from the RAW event list, deliberately: allocation must happen
  // before the async authorize/validate loop, so the block is an upper bound.
  // Events rejected or skipped as idempotent replays still consume their seq —
  // a gap, harmless by design (server_seq is an ordering key, not a count).
  //
  // Project: POST /events is SINGLE-PROJECT per request, and the guard in the
  // dispatch loop below is what makes that true. The project is taken from
  // the TOKEN CLAIMS of the first event that AUTHORIZES — never from the
  // request body — so a body naming someone else's project can neither bump
  // that tenant's counter nor plant a fence row in their ledger. Any later
  // event naming a different project is rejected before dispatch, so no event
  // is ever stamped with a seq from a foreign range.
  //
  // Allocation is therefore lazy: it happens once, on the first authorized
  // event, still before any write transaction opens.
  let allocProjectId: string | null = null
  let seqBase = 0

  const accepted: AcceptedEntry[] = []
  const rejected: RejectedEntry[] = []
  // Chain-mutating events that were accepted (logged) but did NOT advance
  // the projection — stale siblings. Keyed by event id so we can `has`-check
  // when assembling the response; the value carries enough context for the
  // client to navigate the user to the affected cell's history drawer.
  const staleEntries = new Map<string, StaleEntry>()
  // F5: target.cell.commit events whose sourceEventId pin is stale (source
  // has advanced since the translator last fetched). Accepted + projected
  // (LWW) but flagged so the client can surface a "source changed" banner.
  const staleSourceEntries: StaleSourceEntry[] = []

  // ── Per-event accumulation ─────────────────────────────────────────────

  interface PendingEntry {
    id: string
    stmtStart: number
    stmtCount: number
    eventFrame: Extract<RealtimeMessage, { t: 'event' }>
    /** `events.server_seq` assigned to this event (seqBase + slot). */
    serverSeq: number
    dirtyEntry?: { project: string; file: string; tables: Set<ProjectionTable> }
    /** Verified author (JWT claims, not the client-supplied event field) —
     * broadcast as `by` so clients can suppress own-write banners. */
    author: string
    /** True when the write arrived on the external Agent API channel
     * (token-bridge minted token, claims.src === 'external'). Broadcast as
     * `via: 'external'` so the credential owner's OWN browser does NOT
     * suppress the frame as an own-write echo — no outbox write happened
     * client-side, so skipping the refetch would hide the agent's commit
     * until a manual reload. Browser sync-tokens carry role-resolution
     * paths in `src` ('override' | 'group' | 'org' | 'creator' |
     * 'platform'), never 'external', so this is server-verified. */
    viaExternal: boolean
    /** AD-2 chain slot claimed by this event (chain-mutating winners of the
     * pre-check only) — read back after commit to flag in-flight losers. */
    chainSlot?: ChainSlot
    /** Index (relative to stmtStart) of the claim + head-CAS gated cells
     * write; 0 rows after commit means the event lost and is stale. */
    headStmtIndex?: number
    /** File whose counter recompute was deferred (QW-10) — coalesced to one
     * recompute per (file, chunk). */
    counterFile?: { projectId: string; fileId: string }
  }

  const pendingStmts: AquillaStatement[] = []
  const pendingEntries: PendingEntry[] = []
  const seenEventIds = new Set<string>()

  // PERF-2: collect the ids/cells the per-event pre-checks need and fetch
  // each concern in one batched SELECT up front (see the helpers above for
  // why this is semantics-preserving). Collection runs over raw, not-yet-
  // authorized events — a superset; prefetching for an event that authorize()
  // later rejects is a harmless read.
  const candidateIds = new Set<string>()
  const chainCells = new Map<string, CellKey>()
  const sourceCommitCells = new Map<string, CellKey>()
  const validateCells = new Map<string, CellKey>()
  const foreignCommentIds = new Set<string>()
  for (const e of rawEvents) {
    if (typeof e.id === 'string') candidateIds.add(e.id)
    if (isForeignCommentKind(e.kind)) {
      const p = e.payload as { commentId?: string } | undefined
      if (typeof p?.commentId === 'string') foreignCommentIds.add(p.commentId)
    }
    if (
      typeof e.projectId !== 'string' ||
      typeof e.fileId !== 'string' ||
      typeof e.cellId !== 'string'
    ) {
      continue
    }
    const key = cellKeyOf(e.projectId, e.fileId, e.cellId)
    // target.cell.commit (the F5 source-pin check's kind) is chain-mutating,
    // so the head prefetch below also covers it.
    if (isChainMutatingKind(e.kind)) {
      chainCells.set(key, { projectId: e.projectId, fileId: e.fileId, cellId: e.cellId })
    }
    // FRO-476: local source.cell.commit is the kind the live-mode lock
    // rejects (see prefetchLiveMirrorLocks). source.cell.mirror is exempt —
    // it's how the lock's own content gets updated.
    if (e.kind === 'source.cell.commit') {
      sourceCommitCells.set(key, { projectId: e.projectId, fileId: e.fileId, cellId: e.cellId })
    }
    // FRO-189 self-validation check (see prefetchLastEditors) — fetched for
    // every candidate regardless of the project's allowSelfValidation
    // setting, which isn't known until the per-event loop below.
    if (e.kind === 'cell.validate') {
      validateCells.set(key, { projectId: e.projectId, fileId: e.fileId, cellId: e.cellId })
    }
  }
  const [existingIds, chainWinners, cellHeads, liveMirrorLocks, commentAuthors, lastEditors] =
    await Promise.all([
      readExistingEventIds(db, candidateIds),
      prefetchChainWinners(db, [...chainCells.values()]),
      prefetchCellHeads(db, [...chainCells.values()]),
      prefetchLiveMirrorLocks(db, [...sourceCommitCells.values()]),
      prefetchCommentAuthors(db, foreignCommentIds),
      prefetchLastEditors(db, [...validateCells.values()]),
    ])

  // PERF-2: project_settings is read at most once per (request, project) —
  // and, since perf/events-write-path, that ONE memo is shared with the
  // authority carve-outs inside authorize() (request-cache.ts), which used to
  // re-read the same row per event. No event kind mutates project_settings /
  // org_settings / projects.org_id (their only writers are the
  // migrate-settings route and auth-worker), so the memo cannot serve a stale
  // read to any event in this batch. Read/parse failures read as null — the
  // same per-event fallback as before (validate: skip enforcement;
  // harmonize: hard floor).
  const requestCache = makeRequestCache(db)
  const readProjectSettings = async (
    projectId: string,
  ): Promise<Record<string, unknown> | null> => {
    try {
      return await requestCache.projectSettings(projectId)
    } catch {
      // Settings load failure is non-fatal — callers fall back to their
      // defaults rather than blocking the batch.
      return null
    }
  }

  // FRO-346: live membership re-check, once per (project, user) per request.
  // authorize() proves the token was valid at MINT time; this proves the
  // author still has a grant path NOW, so removing a member terminates their
  // write access on the very next flush instead of at token expiry (15 min).
  // `src: "platform"` tokens (ADMIN_EMAILS operators) are exempt — they have
  // no membership rows to re-check. See events/membership.ts for the full
  // enforcement contract.
  const membershipCache = new Map<string, Promise<MembershipCheck>>()
  const membershipFor = (projectId: string, userId: number): Promise<MembershipCheck> => {
    const key = `${projectId}\0${userId}`
    let pending = membershipCache.get(key)
    if (!pending) {
      pending = checkProjectMembership(db, projectId, userId)
      membershipCache.set(key, pending)
    }
    return pending
  }

  for (const [eventIndex, rawEvent] of rawEvents.entries()) {
    // Authorize.
    const authResult = await authorize(token, rawEvent, env.SYNC_SECRET_KEY, db, requestCache)
    if (!authResult.ok) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: authResult.status,
        reason: authResult.reason,
      })
      continue
    }

    // Single-project guard + lazy allocation (see the allocation note above).
    // claims.projectId is token-verified: authorize() already proved the token
    // is scoped to this event's project, so it can never name a tenant the
    // caller has no access to.
    const eventProjectId = authResult.event.claims.projectId
    if (allocProjectId === null) {
      allocProjectId = eventProjectId
      seqBase = await allocateSeqRange(db, allocProjectId, rawEvents.length)
    } else if (eventProjectId !== allocProjectId) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: 400,
        reason: 'all events in one request must belong to the same project',
      })
      continue
    }

    // FRO-346: revoked-membership gate (see membershipFor above).
    if (authResult.event.claims.src !== 'platform') {
      const membership = await membershipFor(
        authResult.event.claims.projectId,
        authResult.event.claims.userId,
      )
      if (membership === 'revoked') {
        rejected.push({
          id: rawEvent.id ?? '(unknown)',
          status: 403,
          reason: 'membership revoked',
        })
        continue
      }
    }

    // FRO-476 live-mode lock: reject local source.cell.commit on cells the
    // mirror sync owns (live link + upstream_event_id set). Downstream-added
    // cells (no upstream_event_id) and clone-mode/unlinked projects are
    // unaffected — see prefetchLiveMirrorLocks.
    if (
      rawEvent.kind === 'source.cell.commit' &&
      rawEvent.fileId &&
      rawEvent.cellId &&
      liveMirrorLocks.has(cellKeyOf(rawEvent.projectId, rawEvent.fileId, rawEvent.cellId))
    ) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: 409,
        reason: 'cell is mirrored from a live-linked upstream source; edits must be made upstream',
      })
      continue
    }

    // Idempotency: same id within batch → accept silently.
    if (seenEventIds.has(rawEvent.id)) {
      accepted.push({ id: rawEvent.id })
      continue
    }
    seenEventIds.add(rawEvent.id)

    // Idempotency: same id across requests → accept silently (batched
    // pre-fetch; one SELECT per request, not per event).
    if (existingIds.has(rawEvent.id)) {
      accepted.push({ id: rawEvent.id })
      continue
    }

    // Assign server_ts (monotone within request) and the pre-allocated
    // server_seq for this event's slot in the request's block.
    const serverTs = nextServerTs++
    const serverSeq = seqBase + eventIndex

    // AD-2 parent-chain decision. The candidate hasn't been INSERTed yet,
    // so `isWinningChild` looks for a prior sibling with the same
    // (project_id, file_id, cell_id, parent_id). If none exists, this
    // candidate wins. The events INSERT below will land it as the chain
    // head and any future sibling with the same parent will see this row
    // as the existing winner.
    //
    // The guard applies only to events that advance `cells.event_id`
    // (the chain-mutating cell.* kinds). Validation kinds and file.create
    // do not compete for the chain head, so they always project.
    const candidate: PersistedEvent = {
      id: rawEvent.id,
      schemaVersion: rawEvent.schemaVersion,
      projectId: rawEvent.projectId,
      fileId: rawEvent.fileId ?? null,
      cellId: rawEvent.cellId ?? null,
      parentId: rawEvent.parentId ?? null,
      kind: rawEvent.kind,
      author: authResult.event.claims.username,
      payload: rawEvent.payload,
      clientTs: rawEvent.clientTs,
      serverTs,
    }
    // ARCH-4: single source of truth for chain-mutating classification —
    // shared with the projection guard and rebuild (event-projection.ts).
    // (The previous 17-kind deny-list here was verified equivalent for every
    // existing EventKind before collapsing.)
    const isChainMutating = isChainMutatingKind(rawEvent.kind)
    // Chain-mutating events are a compare-and-swap on the cell's head
    // (AQU-1154, invariant I1): the event advances the projection iff its
    // parentId IS the current `cells.event_id` for its side/lane — or the
    // row does not exist yet (a cell's first target commit chains on the
    // SOURCE head). Everything else — a sibling that lost, AND anything
    // chained on a loser — lands in `events` but does NOT advance the
    // projection, and is reported via `stale` so the client outbox can
    // surface "your edit was bumped" and revalidate, rather than silently
    // overwriting the newer winner.
    //
    // First-child-of-parent (the chain_claims slot) is kept as well: it is
    // what arbitrates two in-flight siblings of one parent, and it keeps a
    // claim-less "ghost" event's slot blocked until a rebuild surfaces it.
    // But first-child alone let a stale branch climb back onto the head —
    // B1 loses to A1, B's client keeps chaining on B1, and B2 found the
    // (cell, B1) slot free and overwrote A1 — so the head check is the rule.
    //
    // NOTE (RACE-2): this is only the PRE-check against the committed state
    // (winners + heads prefetched in one SELECT each — prefetchChainWinners /
    // prefetchCellHeads). Two IN-FLIGHT requests can both pass it; the real
    // arbiter is the transaction: the atomic chain_claims row plus the
    // `cells.event_id = parentId` CAS on the projection write itself
    // (event-projection.ts), and the row count of that write is read back
    // after commit to flag the loser as stale.
    let updateProjection = true
    let headKey: string | undefined
    if (isChainMutating && candidate.fileId && candidate.cellId) {
      // Side/lane-qualified slot — MUST match the qualification the claim
      // insert (handlers/cell-events.ts) and isWinningChild use, or a second
      // lane's first commit / a source correction sharing a target commit's
      // parent is judged a sibling of the other namespace and dead-lettered.
      const winner = chainWinners.get(
        slotKey({
          projectId: candidate.projectId,
          fileId: candidate.fileId,
          cellId: candidate.cellId,
          parentKey: eventQualifiedParentKey(candidate.parentId, candidate.kind, candidate.payload),
        }),
      )
      updateProjection = winner === undefined || winner === candidate.id

      headKey = headKeyOf(
        candidate.projectId,
        candidate.fileId,
        candidate.cellId,
        candidate.kind,
        candidate.payload,
      )
      // A parent-null delete is a tombstone (AQU-931): it extends no chain
      // and applies regardless of the head.
      if (isChainArbitrated(candidate.kind, candidate.parentId)) {
        const head = cellHeads.get(headKey)
        if (head !== undefined && head !== candidate.parentId) updateProjection = false
      }
    }
    // A chain-mutating event that does NOT advance the projection is a stale
    // sibling: it's still logged + 200-accepted, but the caller's change had
    // no visible effect. Report it so the client surfaces it instead of
    // treating "accepted" as "saved" (the old silent-loss bug).
    if (isChainMutating && !updateProjection) {
      staleEntries.set(rawEvent.id, {
        id: rawEvent.id,
        fileId: rawEvent.fileId ?? null,
        cellId: rawEvent.cellId ?? null,
      })
    } else if (headKey !== undefined) {
      // Track the head THIS request will have advanced to, so a same-batch
      // chain C1 (parent H) → C2 (parent C1) passes: C1 moves the head
      // earlier in the same transaction (statement order). A delete removes
      // the row, so the next event on that key applies regardless of parent.
      if (candidate.kind.endsWith('.delete')) cellHeads.delete(headKey)
      else cellHeads.set(headKey, candidate.id)
    }

    // F5: AD-9 sourceEventId staleness validation for target.cell.commit.
    // If the commit carries a sourceEventId pin and the source row has
    // advanced beyond it, flag it so the client can surface a
    // "source changed — please re-confirm" hint. The event is still accepted
    // and projected (LWW) so the translator's work is not lost.
    if (rawEvent.kind === 'target.cell.commit' && rawEvent.fileId && rawEvent.cellId) {
      const tp = rawEvent.payload as { sourceEventId?: string | null }
      if (tp.sourceEventId) {
        const currentSourceEventId = cellHeads.get(
          `${cellKeyOf(rawEvent.projectId, rawEvent.fileId, rawEvent.cellId)}\0source\0`,
        )
        if (currentSourceEventId && currentSourceEventId !== tp.sourceEventId) {
          staleSourceEntries.push({
            id: rawEvent.id,
            currentSourceEventId,
          })
        }
      }
    }

    // ── Foreign ownership check ────────────────────────────────────────────
    // For mutations that may target another user's row (comment.edit,
    // comment.delete, comment.resolve, cell.unvalidate with targetUsername),
    // verify the caller is the row's owner OR has maintainer(600)+ role.
    // This runs after the base role gate (authorize) and before dispatch.
    const callerRole = authResult.event.claims.roleLevel
    const callerUsername = authResult.event.claims.username

    if (isForeignCommentKind(rawEvent.kind)) {
      const p = rawEvent.payload as { commentId?: string }
      if (p.commentId) {
        const authorId = commentAuthors.get(p.commentId)

        if (authorId !== undefined && authorId !== callerUsername) {
          // Foreign comment mutation — floor per FOREIGN_COMMENT_ROLE
          // (AQU-999): maintainer for edit/delete, contributor for resolve.
          const foreignFloor = requiredRoleForForeignComment(rawEvent.kind)
          if (callerRole < foreignFloor) {
            const verb = rawEvent.kind === 'comment.resolve' ? 'resolve' : 'mutate'
            rejected.push({
              id: rawEvent.id ?? '(unknown)',
              status: 403,
              reason: `role too low to ${verb} another user's comment (requires ${roleLabel(foreignFloor)})`,
            })
            continue
          }
        }
        // If authorId is undefined the comment doesn't exist; projection will
        // no-op, which is the correct behaviour (idempotent delete of a
        // missing row).
      }
    }

    if (rawEvent.kind === 'cell.unvalidate') {
      const p = rawEvent.payload as { targetUsername?: string }
      if (p.targetUsername && p.targetUsername !== callerUsername) {
        // Foreign unvalidate — requires maintainer+.
        if (callerRole < ROLE.MAINTAINER) {
          rejected.push({
            id: rawEvent.id ?? '(unknown)',
            status: 403,
            reason: `role too low to remove another user's validation (requires maintainer)`,
          })
          continue
        }
      }
    }

    // ── Validation config enforcement (FRO-189) + threshold (FRO-279) ───────
    // For cell.validate events:
    //   1. validationRoleFloor — reject if caller's role < configured floor
    //   2. validationNamedUsers — reject if caller is not in the allowlist
    //   3. allowSelfValidation=false — reject if caller is the cell's last editor
    //   4. (FRO-279) validationCount — read for the projection's threshold recompute
    // For cell.unvalidate events:
    //   The FRO-189 role/named/self checks do NOT apply (unvalidation is always
    //   allowed by the authorized caller). But the projection still needs the
    //   threshold so the validated flag re-derives correctly after the removal.
    //
    // `validationCountForDispatch` is populated here and forwarded to dispatchEvent.
    // Settings are read via readProjectSettings (memoized once per request per
    // project — failure is non-fatal: skip enforcement rather than blocking all
    // validates when settings are unavailable).
    let validationCountForDispatch: number | undefined
    if (rawEvent.kind === 'cell.validate' || rawEvent.kind === 'cell.unvalidate') {
      const parsed = await readProjectSettings(rawEvent.projectId)
      if (parsed && typeof parsed.validationCount === 'number' && parsed.validationCount >= 1) {
        validationCountForDispatch = parsed.validationCount as number
      }
      // FRO-189 checks are only for cell.validate.
      if (rawEvent.kind === 'cell.validate') {
        let validationRoleFloor: string | undefined
        let validationNamedUsers: string[] | undefined
        let allowSelfValidation: boolean | undefined
        if (parsed) {
          if (typeof parsed.validationRoleFloor === 'string') {
            validationRoleFloor = parsed.validationRoleFloor as string
          }
          if (Array.isArray(parsed.validationNamedUsers)) {
            validationNamedUsers = parsed.validationNamedUsers as string[]
          }
          if (typeof parsed.allowSelfValidation === 'boolean') {
            allowSelfValidation = parsed.allowSelfValidation
          }
        }

        // 1. Role floor check.
        if (validationRoleFloor != null) {
          const FLOOR_MAP: Record<string, number> = {
            reviewer: ROLE.REVIEWER,
            project_lead: ROLE.PROJECT_LEAD,
            maintainer: ROLE.MAINTAINER,
          }
          const floorLevel = FLOOR_MAP[validationRoleFloor]
          if (floorLevel != null && callerRole < floorLevel) {
            rejected.push({
              id: rawEvent.id ?? '(unknown)',
              status: 403,
              reason: `role too low to validate (project requires ${validationRoleFloor} or above)`,
            })
            continue
          }
        }

        // 2. Named-user allowlist check.
        if (validationNamedUsers != null && validationNamedUsers.length > 0) {
          if (!validationNamedUsers.includes(callerUsername)) {
            rejected.push({
              id: rawEvent.id ?? '(unknown)',
              status: 403,
              reason: `user '${callerUsername}' is not in the project's validator allowlist`,
            })
            continue
          }
        }

        // 3. Self-validation check.
        if (allowSelfValidation === false && rawEvent.fileId && rawEvent.cellId) {
          const lastEditor = lastEditors.get(
            cellKeyOf(rawEvent.projectId, rawEvent.fileId, rawEvent.cellId),
          )
          if (lastEditor === callerUsername) {
            rejected.push({
              id: rawEvent.id ?? '(unknown)',
              status: 403,
              reason: `self-validation is not allowed on this project`,
            })
            continue
          }
        }
      }
    }

    // ── Harmonize config enforcement (FRO-186) ────────────────────────────
    // Enforce project-level harmonize_min_role for target.cell.commit events
    // that carry a harmonize_origin payload (the cell.commit.harmonize variant
    // per AD-2). The base role gate (authorize) already confirmed the caller
    // is CONTRIBUTOR+; this additive check raises the floor to project_lead(500)
    // by default, configurable up to maintainer(600) via harmonize_min_role.
    // Lowering below project_lead is not allowed (hard floor per spec).
    if (rawEvent.kind === 'target.cell.commit') {
      const p = rawEvent.payload as { harmonize_origin?: unknown }
      if (p.harmonize_origin != null) {
        // Load harmonize_min_role from project settings (memoized once per
        // request per project — failure is non-fatal: apply the hard floor
        // rather than blocking all harmonize events when settings are
        // unavailable).
        const parsed = await readProjectSettings(rawEvent.projectId)
        const harmonizeMinRole =
          typeof parsed?.harmonize_min_role === 'string'
            ? parsed.harmonize_min_role
            : undefined
        const HARMONIZE_FLOOR_MAP: Record<string, number> = {
          project_lead: ROLE.PROJECT_LEAD,
          maintainer: ROLE.MAINTAINER,
        }
        // Default floor: project_lead(500). Configured floor may only raise it.
        const configuredFloor = harmonizeMinRole != null
          ? (HARMONIZE_FLOOR_MAP[harmonizeMinRole] ?? ROLE.PROJECT_LEAD)
          : ROLE.PROJECT_LEAD
        // Hard floor: never allow below project_lead(500).
        const effectiveFloor = Math.max(configuredFloor, ROLE.PROJECT_LEAD)
        if (callerRole < effectiveFloor) {
          const requiredName = effectiveFloor >= ROLE.MAINTAINER ? 'maintainer' : 'project_lead'
          rejected.push({
            id: rawEvent.id ?? '(unknown)',
            status: 403,
            reason: `role too low to harmonize (project requires ${requiredName} or above)`,
          })
          continue
        }
      }
    }

    // Dispatch. deferFileCounters: the O(file) counter recompute is appended
    // once per (file, chunk) at commit time instead of once per event (QW-10).
    //
    // The try/catch is a net under the whole dispatcher: an unexpected throw in
    // ONE handler used to propagate out of the route and 500 the entire POST,
    // taking every other event in the batch down with it and — because the
    // client reads 5xx as transient and retries without burning its attempt
    // budget — wedging the outbox on that one event forever.
    //
    // 500, deliberately NOT 400: the client's permanent-rejection filter is
    // 4xx-only, so labelling a genuine server bug (null deref, shim failure) a
    // client error would make it silently DELETE the user's event. A 500 in
    // `rejected` instead falls through to markOutboxAttempt, burns the retry
    // budget, terminates as `failed` and stays visible in the inspector —
    // no client change, and no reclassification for the other 40+ kinds.
    let outcome: DispatchOutcome
    try {
      outcome = dispatchEvent(db, authResult.event, serverTs, {
        serverSeq,
        updateProjection,
        deferFileCounters: true,
        validationCount: validationCountForDispatch,
      })
    } catch (err) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: 500,
        reason: `handler for ${rawEvent.kind} failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }
    if (!outcome.ok) {
      rejected.push({
        id: rawEvent.id ?? '(unknown)',
        status: outcome.status,
        reason: outcome.reason,
      })
      continue
    }

    const stmtsBefore = pendingStmts.length
    for (const stmt of outcome.result.stmts) {
      pendingStmts.push(stmt)
    }

    const frame = outcome.result.eventFrame
    let dirtyEntry: PendingEntry['dirtyEntry']
    if (frame.file) {
      dirtyEntry = {
        project: frame.project,
        file: frame.file,
        tables: new Set(outcome.result.dirtyTables),
      }
    }

    pendingEntries.push({
      id: rawEvent.id,
      stmtStart: stmtsBefore,
      stmtCount: pendingStmts.length - stmtsBefore,
      eventFrame: outcome.result.eventFrame,
      serverSeq,
      dirtyEntry,
      author: authResult.event.claims.username,
      viaExternal: authResult.event.claims.src === 'external',
      chainSlot: outcome.result.chainSlot,
      headStmtIndex: outcome.result.headStmtIndex,
      counterFile: outcome.result.counterFile,
    })
  }

  // ── Commit accumulated statements in batch-limit-sized chunks ──────────
  if (pendingStmts.length > 0) {
    interface PendingChunk {
      entries: PendingEntry[]
      stmts: AquillaStatement[]
    }

    const chunks: PendingChunk[] = []
    let currentChunk: PendingChunk = { entries: [], stmts: [] }

    // QW-10: the deferred file-counter recompute runs once per (file, chunk),
    // appended when the chunk is sealed so it commits in the SAME transaction
    // as the chunk's events — committed chunks always leave correct counters,
    // exactly like the old per-event recompute, at 1/N the aggregate scans.
    // (A sealed chunk may exceed BATCH_LIMIT by the handful of per-file
    // recomputes; the limit is a self-imposed soft cap, not a Postgres one.)
    const sealChunk = (chunk: PendingChunk): void => {
      const counterFiles = new Map<string, {
        projectId: string
        fileId: string
        fullSections: boolean
        cellIds: Set<string>
      }>()
      for (const entry of chunk.entries) {
        if (entry.counterFile) {
          const key = `${entry.counterFile.projectId}|${entry.counterFile.fileId}`
          let impact = counterFiles.get(key)
          if (!impact) {
            impact = { ...entry.counterFile, fullSections: false, cellIds: new Set() }
            counterFiles.set(key, impact)
          }
          if (entry.eventFrame.kind.startsWith('source.cell.')) {
            impact.fullSections = true
          } else if (entry.eventFrame.cell) {
            impact.cellIds.add(entry.eventFrame.cell)
          }
        }
      }
      const recomputeTs = Date.now()
      for (const f of counterFiles.values()) {
        chunk.stmts.push(fileCountersRecomputeStmt(db, f.projectId, f.fileId, recomputeTs))
        if (f.fullSections) {
          chunk.stmts.push(...fullProgressRecomputeStmts(db, f.projectId, f.fileId, recomputeTs))
        } else {
          chunk.stmts.push(fileProgressRecomputeStmt(db, f.projectId, f.fileId, recomputeTs))
          if (f.cellIds.size > 0) {
            chunk.stmts.push(
              sectionsProgressRecomputeStmt(db, f.projectId, f.fileId, recomputeTs, [...f.cellIds]),
            )
          }
        }
      }
      chunks.push(chunk)
    }

    for (const entry of pendingEntries) {
      const eventStmts = pendingStmts.slice(
        entry.stmtStart,
        entry.stmtStart + entry.stmtCount,
      )

      if (eventStmts.length > BATCH_LIMIT) {
        rejected.push({
          id: entry.id,
          status: 500,
          reason: `event produced ${eventStmts.length} SQL statements, exceeding batch limit ${BATCH_LIMIT}`,
        })
        continue
      }

      if (
        currentChunk.stmts.length > 0 &&
        currentChunk.stmts.length + eventStmts.length > BATCH_LIMIT
      ) {
        sealChunk(currentChunk)
        currentChunk = { entries: [], stmts: [] }
      }

      currentChunk.entries.push(entry)
      currentChunk.stmts.push(...eventStmts)
    }

    if (currentChunk.stmts.length > 0) {
      sealChunk(currentChunk)
    }

    const committedEntries: PendingEntry[] = []

    // M1-2 / AQU-1154: after each chunk commits, flag any event that lost
    // an IN-FLIGHT race (it passed the pre-check, but inside the transaction
    // another event took its chain claim or moved the head first). Its event
    // row is committed to the log but its gated cells write was a no-op —
    // the batch result's row count for that statement is 0. Without this the
    // client would treat "accepted" as "saved" (the old silent-loss bug).
    // Reading the row count back from the same transaction is race-free:
    // no later request can change what THIS write did.
    const flagChainLosers = (
      chunk: PendingChunk,
      results: ReadonlyArray<{ meta: { changes: number } }>,
    ): void => {
      let offset = 0
      for (const e of chunk.entries) {
        if (e.headStmtIndex !== undefined && !staleEntries.has(e.id)) {
          if (results[offset + e.headStmtIndex]?.meta.changes === 0) {
            staleEntries.set(e.id, {
              id: e.id,
              fileId: e.eventFrame.file ?? null,
              cellId: e.eventFrame.cell ?? null,
            })
          }
        }
        offset += e.stmtCount
      }
    }

    try {
      for (const chunk of chunks) {
        const results = await db.batch(chunk.stmts)
        flagChainLosers(chunk, results)
        committedEntries.push(...chunk.entries)
      }
    } catch (err) {
      const committed = new Set(committedEntries.map((entry) => entry.id))
      for (const entry of pendingEntries) {
        if (committed.has(entry.id)) {
          accepted.push({ id: entry.id })
        } else if (!rejected.some((r) => r.id === entry.id)) {
          rejected.push({
            id: entry.id,
            status: 500,
            reason: `DB batch failed: ${String(err)}`,
          })
        }
      }

      return Response.json(
        {
          accepted,
          rejected,
          stale: accepted
            .filter((a) => staleEntries.has(a.id))
            .map((a) => staleEntries.get(a.id)!),
          staleSource: staleSourceEntries,
        },
        { status: 200 },
      )
    }

    for (const entry of committedEntries) {
      accepted.push({ id: entry.id })
    }

    // Comment notifications — fire-and-forget via ctx.waitUntil so they
    // never delay the response. Only fires for comment.create events.
    if (ctx && env.AQUILLA_PG) {
      const baseUrl = env.BASE_URL ?? 'https://aquilla.app'
      for (const entry of committedEntries) {
        if (entry.eventFrame.kind === 'comment.create') {
          // Retrieve the original raw event payload by matching event id.
          const rawEvent = rawEvents.find((e) => e.id === entry.id)
          if (rawEvent) {
            const p = rawEvent.payload as {
              commentId?: string
              body?: string
              parentCommentId?: string | null
            }
            const body = p.body ?? ''
            const parentCommentId = p.parentCommentId ?? null
            ctx.waitUntil(
              sendCommentNotifications({
                env,
                db: env.AQUILLA_PG!,
                baseUrl,
                projectId: rawEvent.projectId,
                author: entry.author,
                body,
                parentCommentId,
              }),
            )
          }
        }
      }
    }

    // Broadcast — non-fatal.
    if (env.FileSync && env.SYNC_SECRET_KEY) {
      const broadcastEnv: BroadcastEnv = {
        FileSync: env.FileSync,
        SYNC_SECRET_KEY: env.SYNC_SECRET_KEY,
      }

      // Coalesce dirty tables per (project, file) before broadcast.
      const dirtyByScope = new Map<string, { project: string; file: string; tables: Set<ProjectionTable> }>()
      for (const entry of committedEntries) {
        if (!entry.dirtyEntry) continue
        const dirty = entry.dirtyEntry
        const key = `${dirty.project}|${dirty.file}`
        const existing = dirtyByScope.get(key)
        if (existing) {
          for (const t of dirty.tables) existing.tables.add(t)
        } else {
          dirtyByScope.set(key, { project: dirty.project, file: dirty.file, tables: new Set(dirty.tables) })
        }
      }

      const broadcasts: Promise<void>[] = []
      for (const entry of committedEntries) {
        broadcasts.push(broadcastRealtime(broadcastEnv, entry.eventFrame))
      }
      for (const { project, file, tables } of dirtyByScope.values()) {
        broadcasts.push(broadcastRealtime(broadcastEnv, {
          v: 1,
          t: 'projection.dirty',
          project,
          file,
          tables: [...tables],
        }))
      }

      await Promise.all(broadcasts)
    }

    // Fan-out event.applied frames to ProjectSync DO so UI clients receive
    // real-time updates via the per-project WebSocket. Non-fatal — a missed
    // broadcast means the client will reconcile on its next poll/revalidate.
    if (env.ProjectSync && env.SYNC_SECRET_KEY) {
      // Group by project — one DO stub per project.
      const byProject = new Map<string, typeof committedEntries>()
      for (const entry of committedEntries) {
        const project = entry.eventFrame.project
        const list = byProject.get(project)
        if (list) list.push(entry)
        else byProject.set(project, [entry])
      }
      // Inline each committed cell's CURRENT projected rows (post-commit) on
      // its event.applied frame so clients apply the head directly instead
      // of a GET …/cells?cellIds= round-trip per frame. ONE SELECT for every
      // cell this request touched; skipped when none qualify.
      const rowsByCell = await readEventAppliedRows(db, committedEntries)
      const doFanOut: Promise<void>[] = []
      for (const [project, entries] of byProject) {
        const id = env.ProjectSync.idFromName(project)
        const stub = env.ProjectSync.get(id)
        const messages = entries.map((entry) => {
          const frame = entry.eventFrame
          const carriesRows =
            frame.file !== undefined && frame.cell !== undefined && isEventAppliedRowsKind(frame.kind)
          return {
            t: 'event.applied',
            id: frame.id,
            kind: frame.kind,
            project: frame.project,
            ...(frame.file ? { file: frame.file } : {}),
            ...(frame.cell ? { cell: frame.cell } : {}),
            // Verified author — lets the author's own client skip the
            // "changed elsewhere" banner when its write bounces back.
            by: entry.author,
            // Agent-API channel marker — forces the credential owner's own
            // browser to treat the frame as remote (no local outbox write
            // exists to have already refetched). See PendingEntry.viaExternal.
            ...(entry.viaExternal ? { via: 'external' as const } : {}),
            // Additive: server_seq + current rows for cell-content events.
            // `rows` is omitted (not empty) when the request exceeded the
            // per-request cell cap — clients then refetch as before.
            ...(carriesRows ? { serverSeq: entry.serverSeq } : {}),
            ...(carriesRows && rowsByCell
              ? { rows: rowsByCell.get(cellRowsKey(frame.project, frame.file!, frame.cell!)) ?? [] }
              : {}),
          }
        })
        // PERF-8: ONE __broadcast subrequest per (project, request) — the
        // per-event fan-out burned ~1 subrequest per committed event against
        // the 1000/invocation cap. Single events keep the legacy one-message
        // body (an old DO instance mid-rolling-deploy still understands it);
        // larger batches use the additive broadcast.batch envelope, which the
        // DO unpacks into the same per-event WS frames clients already parse.
        const body = JSON.stringify(
          messages.length === 1 ? messages[0] : { t: 'broadcast.batch', messages },
        )
        doFanOut.push(
          stub.fetch('http://do.internal/__broadcast', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            body,
          }).then(async (res) => {
            if (!res.ok) console.warn(`[events/route] ProjectSync broadcast failed for ${project}: HTTP ${res.status}`)
          }).catch((err) => {
            console.warn('[events/route] ProjectSync broadcast error:', err)
          }),
        )
      }
      await Promise.all(doFanOut)
    }

    // FRO-479 push accelerator — see notifyLiveDownstreamsOfUpstreamChanges
    // above for the full contract. Build the lane-relevant per-upstream-
    // project delta from what just committed, and fire the notify
    // fire-and-forget via ctx.waitUntil so it can NEVER delay this response
    // (the acceptance criterion is "upstream commit latency is not
    // measurably regressed by having many downstreams"). Skipped entirely
    // when ProjectSync/ctx aren't bound (dev/test envs without the DO) —
    // the lazy-pull mirror sync remains the deterministic floor either way.
    if (ctx && env.ProjectSync && env.SYNC_SECRET_KEY) {
      const laneDeltaByProject = new Map<
        string,
        { fileIds: Set<string>; cellIds: Set<string> }
      >()
      for (const entry of committedEntries) {
        const frame = entry.eventFrame
        if (!LINK_NOTIFY_LANE_KINDS.has(frame.kind)) continue
        let delta = laneDeltaByProject.get(frame.project)
        if (!delta) {
          delta = { fileIds: new Set(), cellIds: new Set() }
          laneDeltaByProject.set(frame.project, delta)
        }
        if (frame.file) delta.fileIds.add(frame.file)
        if (frame.cell) delta.cellIds.add(frame.cell)
      }
      if (laneDeltaByProject.size > 0) {
        const projectSync = env.ProjectSync
        const secretKey = env.SYNC_SECRET_KEY
        ctx.waitUntil(
          notifyLiveDownstreamsOfUpstreamChanges(db, projectSync, secretKey, laneDeltaByProject).catch(
            (err) => {
              console.warn('[events/route] link-notify hook failed:', err)
            },
          ),
        )
      }
    }
  }

  // Settle the allocation. Only reached when EVERY chunk committed (the
  // batch-failure path returns above) or when there was nothing to commit at
  // all — in both cases no writer is still in flight for this block, so the
  // reader fence can drop. On partial failure we deliberately skip this: the
  // ledger row expires via PENDING_ALLOC_TTL_MS and holds the advertised
  // cursor down meanwhile (conservative, correct).
  if (allocProjectId) {
    try {
      const settled = await buildSettleSeqRangeStmt(db, allocProjectId, seqBase).run()
      if ((settled.results?.length ?? 0) === 0) {
        console.warn(
          `[seq-ledger] settle found no allocation row (project=${allocProjectId}, firstSeq=${seqBase}) — ` +
            'batch outlived PENDING_ALLOC_TTL_MS; readers may have advanced past these seqs',
        )
      }
    } catch (err) {
      // Non-fatal: the events are committed. An unsettled row only fences the
      // advertised cursor until the TTL expires.
      console.warn('[events/route] seq allocation settle failed:', err)
    }
  }

  return Response.json({
    accepted,
    rejected,
    stale: accepted
      .filter((a) => staleEntries.has(a.id))
      .map((a) => staleEntries.get(a.id)!),
    staleSource: staleSourceEntries,
  })
}
