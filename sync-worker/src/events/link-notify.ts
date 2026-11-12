// ── FRO-479 push accelerator: notify live downstreams of upstream commits ──
//
// Hard constraint (spec §8): push is a LOSSY ACCELERATOR, never load-bearing.
// The FRO-476 mirror sync (lazy-pull on file open, `POST /link/sync`) is the
// deterministic self-healing floor — this hook only shaves the "next open"
// wait down to "seconds" for downstreams that are already connected. It must
// never perform an eager fan-out WRITE on the upstream commit path (no events
// minted here, no DB writes) and must never be awaited before the response.
//
// Which upstream changes count is NOT decided here. It is `laneKindsFor` in
// link-sync.ts, per downstream link shape — the same list the mirror sync's
// freshness probe reads to decide whether to run. AQU-1545: this file used to keep its
// own copy of the source-lane list; hide/show (AQU-1453) and file rename
// (AQU-1358) were added to link-sync's list but not the copy, so an open
// downstream only saw them after a reload, and a `consumes: 'target'`
// downstream was never told about the upstream translations it mirrors.
// Comments/audio/BT events never mirror on any link shape, so they never
// produce a frame — a notify that counted them would make every downstream
// "blink" on unrelated upstream noise.

import { laneKindsFor, laneRelevantHeadSeq, linkConsumesOf, type LinkConsumes } from './link-sync'
import type { ServerLinkUpstreamChanged } from '../project-do-handlers'

/** Per-commit cap on distinct cell ids carried in the frame (spec §8: "capped
 *  at 64"). The rest converge lazily via the mirror sync's own delta fold —
 *  this is a hint for a targeted client refetch, not the source of truth. */
const LINK_NOTIFY_CELL_ID_CAP = 64

/** Safety ceiling on downstreams notified for one commit batch — a guard on
 *  the Workers subrequest budget, NOT a product cap. AQU-1830: this used to be
 *  50, which silently stopped notifying the 51st downstream of a popular base
 *  text, so those downstreams only ever caught up on next file open. What
 *  actually bounds the fan-out now is the idle skip below: a downstream nobody
 *  is looking at costs no subrequest. Hitting this ceiling is a scale event
 *  worth a log line, not normal operation.
 *  (Spec §8 sizes the population at up to 600 downstreams.) */
const LINK_NOTIFY_DOWNSTREAM_CAP = 900

/** AQU-1830: at most one notify per downstream per window. A burst of upstream
 *  commits (a re-import, or someone simply typing) collapses to a leading
 *  frame plus one trailing frame per window instead of one frame per commit.
 *  The trailing edge is load-bearing: the client folds the whole delta from
 *  the server on ANY frame (`createLinkUpstreamChangedHandler`), so the frame
 *  is a trigger rather than a payload — but the LAST commit of a burst must
 *  still produce one, or an open downstream sits stale until it reloads. */
const LINK_NOTIFY_COALESCE_WINDOW_MS = 2_000

/** AQU-1830: how long a downstream whose DO reported zero connected sockets is
 *  skipped outright. `__broadcast` already answers with `recipients`, so one
 *  send per TTL tells us whether anybody is there — an idle downstream costs
 *  one subrequest per TTL instead of one per upstream commit. Kept short
 *  because a client that connects mid-window hears nothing until it lapses;
 *  that is harmless (the lazy mirror sync on file open is the deterministic
 *  floor) but it should not last long. */
const LINK_NOTIFY_IDLE_TTL_MS = 10_000

/** AQU-1830: DO subrequests in flight at once. With the 50-downstream
 *  truncation gone, bound how many sends are concurrent rather than how many
 *  downstreams are reached. */
const LINK_NOTIFY_SEND_CONCURRENCY = 16

/** Only sweep the per-downstream coalescer bookkeeping once it is big enough
 *  to be worth walking (both maps are isolate-lifetime, keyed by downstream
 *  id, and each entry is a few words). */
const LINK_NOTIFY_STATE_SWEEP_THRESHOLD = 1_000

/** How long a project's downstream list is cached in-isolate before being
 *  re-queried (spec §8: "cached in-memory per isolate with short TTL"). Link
 *  creation/detach is a rare admin action, so a short window trades a little
 *  staleness on the notify path (never load-bearing) for avoiding a query on
 *  every single commit. */
const LINK_NOTIFY_DOWNSTREAM_CACHE_TTL_MS = 30_000

const LINK_SHAPES: readonly LinkConsumes[] = ['source', 'target']

const LANE_KIND_SETS: Readonly<Record<LinkConsumes, ReadonlySet<string>>> = {
  source: new Set(laneKindsFor('source')),
  target: new Set(laneKindsFor('target')),
}

/** One committed upstream event, reduced to what the notify needs. */
export interface LaneTouch {
  kind: string
  file?: string
  cell?: string
}

interface LiveDownstream {
  id: string
  consumes: LinkConsumes
}

interface DownstreamCacheEntry {
  downstreams: LiveDownstream[]
  expiresAt: number
}

/** What a downstream is owed once its coalesce window closes, merged across
 *  every commit batch that landed inside the window. */
interface PendingNotify {
  upstream: string
  fileIds: Set<string>
  cellIds: Set<string>
  filesChanged: boolean
  untilSeq: number
}

interface CoalesceEntry {
  /** When a frame was last actually handed to this downstream's DO. */
  lastSentAt: number
  /** Merged delta waiting for the window to close; null when nothing is owed. */
  pending: PendingNotify | null
  /** True while a trailing flush for this downstream is already armed. */
  flushScheduled: boolean
}

// Isolate-lifetime caches — module scope is intentional (mirrors the pattern
// already used for per-isolate memoization elsewhere in this worker). Keyed
// by upstream project id.
const downstreamCache = new Map<string, DownstreamCacheEntry>()

// AQU-1830 coalescer + idle bookkeeping, keyed by DOWNSTREAM project id.
// Isolate-lifetime like the cache above, and like it, losing the state to an
// isolate eviction only costs an extra notify (or a skipped coalesce) — never
// convergence, which the lazy mirror sync owns.
const coalesceState = new Map<string, CoalesceEntry>()
/** Downstream id → timestamp until which its DO is treated as having no sockets. */
const idleUntil = new Map<string, number>()

/** Knobs the tests pin so coalescing and the idle skip can be asserted
 *  without depending on wall-clock timing (AGENTS.md: machine speed must not
 *  decide correctness). Production always runs the defaults. */
interface LinkNotifyTuning {
  coalesceWindowMs: number
  idleTtlMs: number
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const DEFAULT_TUNING: LinkNotifyTuning = {
  coalesceWindowMs: LINK_NOTIFY_COALESCE_WINDOW_MS,
  idleTtlMs: LINK_NOTIFY_IDLE_TTL_MS,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

let tuning: LinkNotifyTuning = DEFAULT_TUNING

/** Test-only escape hatch: every map here is module-scoped (isolate lifetime)
 *  by design, which otherwise leaks state between test cases running in the
 *  same vitest module instance. Not used by production code paths. */
export function __resetLinkNotifyStateForTests(): void {
  downstreamCache.clear()
  coalesceState.clear()
  idleUntil.clear()
  tuning = DEFAULT_TUNING
}

/** Test-only escape hatch — see `LinkNotifyTuning`. */
export function __setLinkNotifyTuningForTests(next: Partial<LinkNotifyTuning>): void {
  tuning = { ...DEFAULT_TUNING, ...next }
}

/** True when `kind` is mirrored by a live link of this shape. */
export function isLinkLaneKind(kind: string, consumes: LinkConsumes): boolean {
  return LANE_KIND_SETS[consumes].has(kind)
}

/**
 * Group a request's committed events by the project that committed them,
 * keeping only kinds that SOME link shape mirrors. Which downstream each
 * touch matters to is decided per link in `notifyLiveDownstreamsOfUpstreamChanges`.
 */
export function collectLaneTouches(
  frames: Iterable<{ kind: string; project: string; file?: string; cell?: string }>,
): Map<string, LaneTouch[]> {
  const byProject = new Map<string, LaneTouch[]>()
  for (const f of frames) {
    if (!LINK_SHAPES.some((shape) => isLinkLaneKind(f.kind, shape))) continue
    let touches = byProject.get(f.project)
    if (!touches) {
      touches = []
      byProject.set(f.project, touches)
    }
    touches.push({ kind: f.kind, file: f.file, cell: f.cell })
  }
  return byProject
}

type LaneDelta = Pick<ServerLinkUpstreamChanged, 'fileIds' | 'cellIds' | 'filesChanged'>

/** What a downstream of this shape should hear about the batch, or null when
 *  nothing in it is mirrored by that shape. A mirrored change with no cell is
 *  a file-level one (file.create / file.rename): the downstream's file list
 *  moves, which a cell refetch never shows. */
function laneDeltaFor(touches: readonly LaneTouch[], consumes: LinkConsumes): LaneDelta | null {
  const fileIds = new Set<string>()
  const cellIds = new Set<string>()
  let relevant = false
  let filesChanged = false
  for (const t of touches) {
    if (!isLinkLaneKind(t.kind, consumes)) continue
    relevant = true
    if (t.file) fileIds.add(t.file)
    if (t.cell) cellIds.add(t.cell)
    else filesChanged = true
  }
  if (!relevant) return null
  return { fileIds: [...fileIds], cellIds: [...cellIds].slice(0, LINK_NOTIFY_CELL_ID_CAP), filesChanged }
}

/**
 * Live (non-clone) downstreams of `upstreamProjectId`. Clone-mode downstreams
 * never receive push frames (spec: "Clone-mode downstreams receive no
 * frames") — they have no mirror sync to trigger and no staleness to refetch.
 * Same `live` gate as `mirrorSync`: a NULL-mode (legacy) link never syncs, so
 * telling it to would only cost the downstream a no-op round trip.
 */
async function loadLiveDownstreams(
  db: AquillaDb,
  upstreamProjectId: string,
  now: number,
): Promise<LiveDownstream[]> {
  const cached = downstreamCache.get(upstreamProjectId)
  if (cached && cached.expiresAt > now) return cached.downstreams

  const { results } = await db
    .prepare(
      `SELECT id, source_link_consumes FROM projects
       WHERE source_project_id = ?
         AND source_link_mode = 'live'`,
    )
    .bind(upstreamProjectId)
    .all<{ id: string; source_link_consumes: string | null }>()

  const downstreams = results.map((r) => ({ id: r.id, consumes: linkConsumesOf(r.source_link_consumes) }))
  downstreamCache.set(upstreamProjectId, {
    downstreams,
    expiresAt: now + LINK_NOTIFY_DOWNSTREAM_CACHE_TTL_MS,
  })
  return downstreams
}

/** True while this downstream's DO is known to have no connected sockets.
 *  Lapsed entries are dropped as we read them, so the map self-cleans on the
 *  hot path and the sweep below only has to catch downstreams that stopped
 *  receiving commits altogether. */
function isIdleDownstream(downstreamId: string, now: number): boolean {
  const until = idleUntil.get(downstreamId)
  if (until === undefined) return false
  if (until > now) return true
  idleUntil.delete(downstreamId)
  return false
}

/** Drop bookkeeping for downstreams that have gone quiet. Only walks the maps
 *  once they are large enough to matter — an isolate serving a handful of
 *  projects never pays for this. */
function sweepLinkNotifyState(now: number): void {
  if (coalesceState.size > LINK_NOTIFY_STATE_SWEEP_THRESHOLD) {
    const staleBefore = now - tuning.coalesceWindowMs * 10
    for (const [id, entry] of coalesceState) {
      if (entry.pending || entry.flushScheduled || entry.lastSentAt > staleBefore) continue
      coalesceState.delete(id)
    }
  }
  if (idleUntil.size > LINK_NOTIFY_STATE_SWEEP_THRESHOLD) {
    for (const [id, until] of idleUntil) {
      if (until <= now) idleUntil.delete(id)
    }
  }
}

/** Bound how many DO subrequests are in flight at once without bounding how
 *  many downstreams are reached. Scoped to one call, so a trailing flush armed
 *  by this request shares its budget. */
function makeSendLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

function frameFor(
  downstreamId: string,
  upstream: string,
  delta: LaneDelta,
  untilSeq: number,
): ServerLinkUpstreamChanged {
  return { t: 'link.upstream-changed', project: downstreamId, upstream, untilSeq, ...delta }
}

function frameFromPending(downstreamId: string, pending: PendingNotify): ServerLinkUpstreamChanged {
  return {
    t: 'link.upstream-changed',
    project: downstreamId,
    upstream: pending.upstream,
    untilSeq: pending.untilSeq,
    fileIds: [...pending.fileIds],
    cellIds: [...pending.cellIds],
    filesChanged: pending.filesChanged,
  }
}

/** Fold one batch's delta into what the downstream is already owed. The cell
 *  id set stops growing at the per-frame cap for the same reason the immediate
 *  path slices: ids are a refetch hint, and the mirror sync folds the rest. */
function mergePending(
  existing: PendingNotify | null,
  upstream: string,
  delta: LaneDelta,
  untilSeq: number,
): PendingNotify {
  const pending: PendingNotify =
    existing ?? { upstream, fileIds: new Set(), cellIds: new Set(), filesChanged: false, untilSeq: 0 }
  pending.upstream = upstream
  for (const file of delta.fileIds) pending.fileIds.add(file)
  for (const cell of delta.cellIds) {
    if (pending.cellIds.size >= LINK_NOTIFY_CELL_ID_CAP) break
    pending.cellIds.add(cell)
  }
  if (delta.filesChanged) pending.filesChanged = true
  if (untilSeq > pending.untilSeq) pending.untilSeq = untilSeq
  return pending
}

/**
 * Hand one frame to a downstream's DO. The reply carries the DO's socket count
 * (`__broadcast` → `{ ok, recipients }`), which is how AQU-1830 learns that
 * nobody is connected downstream and stops waking it every commit. A reply
 * without the field (older DO, or a caller's stub in a test) simply leaves the
 * idle state untouched.
 */
async function sendNotify(
  projectSync: DurableObjectNamespace,
  secretKey: string,
  downstreamId: string,
  frame: ServerLinkUpstreamChanged,
): Promise<void> {
  const stub = projectSync.get(projectSync.idFromName(downstreamId))
  try {
    const res = await stub.fetch('http://do.internal/__broadcast', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(frame),
    })
    if (!res.ok) {
      console.warn(`[events/route] link-notify broadcast failed for ${downstreamId}: HTTP ${res.status}`)
      return
    }
    const recipients = await readRecipientCount(res)
    if (recipients === 0) idleUntil.set(downstreamId, tuning.now() + tuning.idleTtlMs)
    else if (recipients !== null) idleUntil.delete(downstreamId)
  } catch (err) {
    console.warn('[events/route] link-notify broadcast error:', err)
  }
}

async function readRecipientCount(res: Response): Promise<number | null> {
  try {
    const body = (await res.json()) as { recipients?: unknown }
    return typeof body.recipients === 'number' ? body.recipients : null
  } catch {
    return null
  }
}

/** Trailing edge of the coalesce window: wait out the remainder, then send
 *  whatever accumulated. Skipped when the downstream went idle meanwhile —
 *  nobody is listening, and the mirror sync on next open is the floor. */
async function flushPendingNotify(
  projectSync: DurableObjectNamespace,
  secretKey: string,
  downstreamId: string,
  dueInMs: number,
  limit: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  if (dueInMs > 0) await tuning.sleep(dueInMs)
  const entry = coalesceState.get(downstreamId)
  if (!entry) return
  entry.flushScheduled = false
  const pending = entry.pending
  entry.pending = null
  if (!pending) return
  const now = tuning.now()
  if (isIdleDownstream(downstreamId, now)) return
  entry.lastSentAt = now
  await limit(() => sendNotify(projectSync, secretKey, downstreamId, frameFromPending(downstreamId, pending)))
}

/**
 * Send `link.upstream-changed` frames to every live downstream of every
 * project that just committed lane-relevant events in this request. Called
 * via `ctx.waitUntil` AFTER the response is built (see route.ts's call site) —
 * never awaited in the request path, so downstream count can never regress
 * upstream commit latency (spec acceptance criterion).
 *
 * `committed` is `collectLaneTouches`' output: grouped by upstream (the
 * project that committed). Each downstream hears only about the kinds its own
 * link shape mirrors, and is skipped when the batch held none of them.
 *
 * AQU-1830 narrows WHO gets woken rather than capping it:
 *   - a downstream whose DO last reported zero sockets is skipped outright
 *     until the idle TTL lapses (it catches up on next file open, as today);
 *   - a downstream notified inside the coalesce window has the batch merged
 *     into one trailing frame instead of getting a frame per commit;
 *   - every remaining downstream is reached — the old 50 cap silently starved
 *     the rest, and the ceiling now sits at the subrequest budget.
 *
 * One consequence: when a trailing frame is owed, the returned promise stays
 * pending for the rest of that downstream's window (~2s). That is deliberate
 * and costs the author nothing — the caller is `ctx.waitUntil` AFTER the
 * response — and it is also what keeps the trailing frame from being lost to
 * an isolate that would otherwise have nothing left to run.
 */
export async function notifyLiveDownstreamsOfUpstreamChanges(
  db: AquillaDb,
  projectSync: DurableObjectNamespace,
  secretKey: string,
  committed: ReadonlyMap<string, readonly LaneTouch[]>,
): Promise<void> {
  const now = tuning.now()
  sweepLinkNotifyState(now)
  const limit = makeSendLimiter(LINK_NOTIFY_SEND_CONCURRENCY)
  const sends: Promise<void>[] = []

  for (const [upstreamProjectId, touches] of committed) {
    let downstreams: LiveDownstream[]
    try {
      downstreams = await loadLiveDownstreams(db, upstreamProjectId, now)
    } catch (err) {
      console.warn('[events/route] link-notify: downstream lookup failed:', err)
      continue
    }
    if (downstreams.length === 0) continue

    const deltaByShape = new Map<LinkConsumes, LaneDelta>()
    for (const shape of LINK_SHAPES) {
      const delta = laneDeltaFor(touches, shape)
      if (delta) deltaByShape.set(shape, delta)
    }
    const relevant = downstreams.filter((d) => deltaByShape.has(d.consumes))
    // AQU-1830: idle downstreams drop out here, BEFORE the subrequest — that,
    // not a count cap, is what keeps a popular base text's fan-out small.
    const notified = relevant
      .filter((d) => !isIdleDownstream(d.id, now))
      .slice(0, LINK_NOTIFY_DOWNSTREAM_CAP)
    if (relevant.length > LINK_NOTIFY_DOWNSTREAM_CAP) {
      console.warn(
        `[events/route] link-notify: ${upstreamProjectId} has ${relevant.length} live downstreams, ` +
          `above the ${LINK_NOTIFY_DOWNSTREAM_CAP} subrequest ceiling`,
      )
    }
    // One line for the whole batch, never one per downstream — an upstream
    // with hundreds of sleeping downstreams would otherwise bury the log.
    if (notified.length < relevant.length) {
      console.log(
        `[events/route] link-notify: ${upstreamProjectId} → ${notified.length} of ` +
          `${relevant.length} downstreams, ${relevant.length - notified.length} asleep`,
      )
    }
    if (notified.length === 0) continue

    // Advisory only — the client never gates on this value, it's an
    // audit-trail hint (spec §8). Reading it here (post-response, inside
    // waitUntil) costs nothing on the commit path. Per link shape, since the
    // two shapes watch different lanes.
    const untilSeqByShape = new Map<LinkConsumes, number>()
    for (const shape of new Set(notified.map((d) => d.consumes))) {
      try {
        untilSeqByShape.set(shape, await laneRelevantHeadSeq(db, upstreamProjectId, shape))
      } catch (err) {
        console.warn('[events/route] link-notify: head-seq probe failed:', err)
      }
    }

    for (const downstream of notified) {
      const delta = deltaByShape.get(downstream.consumes)!
      const untilSeq = untilSeqByShape.get(downstream.consumes) ?? 0
      const entry = coalesceState.get(downstream.id)

      if (entry && now - entry.lastSentAt < tuning.coalesceWindowMs) {
        // Inside the window: fold the batch in and let the trailing flush
        // carry it, so a burst costs one more subrequest rather than N.
        entry.pending = mergePending(entry.pending, upstreamProjectId, delta, untilSeq)
        if (!entry.flushScheduled) {
          entry.flushScheduled = true
          const dueIn = entry.lastSentAt + tuning.coalesceWindowMs - now
          sends.push(flushPendingNotify(projectSync, secretKey, downstream.id, dueIn, limit))
        }
        continue
      }

      // Leading edge — nothing owed, send straight away.
      const next: CoalesceEntry = entry ?? { lastSentAt: 0, pending: null, flushScheduled: false }
      next.lastSentAt = now
      next.pending = null
      coalesceState.set(downstream.id, next)
      sends.push(
        limit(() =>
          sendNotify(
            projectSync,
            secretKey,
            downstream.id,
            frameFor(downstream.id, upstreamProjectId, delta, untilSeq),
          ),
        ),
      )
    }
  }

  await Promise.all(sends)
}
