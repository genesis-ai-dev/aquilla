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
 */
export async function notifyLiveDownstreamsOfUpstreamChanges(
  db: AquillaDb,
  projectSync: DurableObjectNamespace,
  secretKey: string,
  committed: ReadonlyMap<string, readonly LaneTouch[]>,
): Promise<void> {
  const now = Date.now()
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
    const notified = downstreams
      .filter((d) => deltaByShape.has(d.consumes))
      .slice(0, LINK_NOTIFY_DOWNSTREAM_CAP)
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
      const frame: ServerLinkUpstreamChanged = {
        t: 'link.upstream-changed',
        project: downstream.id,
        upstream: upstreamProjectId,
        untilSeq: untilSeqByShape.get(downstream.consumes) ?? 0,
        ...deltaByShape.get(downstream.consumes)!,
      }
      const id = projectSync.idFromName(downstream.id)
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
                `[events/route] link-notify broadcast failed for ${downstream.id}: HTTP ${res.status}`,
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
