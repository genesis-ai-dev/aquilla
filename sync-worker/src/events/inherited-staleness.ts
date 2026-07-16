// AQU-477: inherited staleness — the per-hop chain walk (design spec §6).
//
// Direct staleness (stale-source-route.ts's existing query) only sees ONE
// hop: does THIS project's local mirrored source head match the target's
// pin? That misses the dormant-middle-hop case the issue's chain scenario
// promises: A (English) fixes a line, B (French) never re-syncs/re-
// translates, C (Chaluba, linked live to B with consumes='target') must
// STILL flag that cell — even though, from C's point of view, its own
// mirror of B hasn't changed at all yet (B hasn't re-committed, so there's
// nothing new for C's mirror sync to pick up).
//
// The walk climbs the link chain from the cell's own project D, ascending
// through each ancestor U, checking three things per hop (§6):
//
//   1. Mirror check — D's local mirrored source row's `upstream_event_id`
//      vs the head of U's *consumed lane* row for that cell_id (source row
//      if D consumes U's source; U's TARGET row if D consumes U's target).
//      Hash-aware: content-identical is never stale (matches the mirror's
//      own no-op suppression, §5).
//   2. Ancestor pin check (only when D consumes U's TARGET) — THE SIDE
//      SWITCH implementers miss (§6): U's own target row has an
//      `source_event_id` pin against U's SIBLING SOURCE row (same cell_id,
//      side='source', inside U's own project) — exactly the same kind of
//      pin stale-source-route.ts's direct-stale query already checks, just
//      one level up. If U's translation is stale against U's OWN source,
//      then C's mirror of that (possibly not-yet-refreshed) translation is
//      transitively stale too, regardless of whether C's mirror sync has
//      run recently.
//   3. Ancestor-behind fallback — U's own `source_link_cursor` vs U's
//      upstream's lane-relevant max seq. If U itself hasn't caught up to
//      ITS upstream, some cell in U's lineage is stale but attributing it
//      to a specific cell requires reading U's un-mirrored delta (deferred
//      to the review panel, AQU-478) — v1 surfaces this as a link-level
//      `behindSeq`-shaped signal on the response, not a per-cell flag.
//   4. Recurse: U becomes D, continue until a self-contained project (no
//      `source_project_id`) or the 32-hop cap (matches chainContains's cap
//      in auth-worker/src/services/source-linking.ts).
//
// Real chains are 2-3 hops; the cap is a safety net against malformed data,
// not a design constraint.

import { contentHash } from "./event-projection"

const MAX_HOPS = 32

export interface InheritedStalenessEnv {
  AQUILLA_PG: AquillaDb
}

interface LinkChainLink {
  projectId: string
  sourceProjectId: string | null
  mode: string | null
  consumes: "source" | "target"
  cursor: number
}

/** Load one project's link row (id, upstream, mode, consumes, cursor). */
async function loadLinkChainLink(db: AquillaDb, projectId: string): Promise<LinkChainLink | null> {
  const row = await db
    .prepare(
      `SELECT source_project_id, source_link_mode, source_link_consumes, source_link_cursor
       FROM projects WHERE id = ?`,
    )
    .bind(projectId)
    .first<{
      source_project_id: string | null
      source_link_mode: string | null
      source_link_consumes: string | null
      source_link_cursor: number | string
    }>()
  if (!row) return null
  return {
    projectId,
    sourceProjectId: row.source_project_id,
    mode: row.source_link_mode,
    consumes: row.source_link_consumes === "target" ? "target" : "source",
    cursor: Number(row.source_link_cursor ?? 0),
  }
}

/**
 * Walk the link chain starting at `startProjectId`, following
 * `source_project_id` upward. Returns the ordered list of hops (starting
 * project first) up to MAX_HOPS. Bounded + cycle-safe (a `seen` set bails
 * the same way chainContains does), matching the existing 32-hop cap.
 */
async function loadLinkChain(db: AquillaDb, startProjectId: string): Promise<LinkChainLink[]> {
  const chain: LinkChainLink[] = []
  const seen = new Set<string>()
  let cursor: string | null = startProjectId
  for (let i = 0; i < MAX_HOPS; i++) {
    if (cursor == null || seen.has(cursor)) break
    seen.add(cursor)
    const link = await loadLinkChainLink(db, cursor)
    if (!link) break
    chain.push(link)
    // Clone-mode / legacy (mode != 'live') links never show upstream drift
    // (§2) — stop climbing past a clone hop; nothing above it is relevant
    // to this project's inherited staleness.
    if (link.mode !== "live") break
    cursor = link.sourceProjectId
  }
  return chain
}

/** One ancestor row's content-bearing state for the mirror check (step 1).
 *  `side` is the row queried: source-consumption links compare against the
 *  ancestor's SOURCE row; target-consumption links compare against the
 *  ancestor's TARGET row (the lane D actually mirrors). */
async function loadAncestorLaneHead(
  db: AquillaDb,
  ancestorProjectId: string,
  side: "source" | "target",
  cellIds: readonly string[],
): Promise<Map<string, { eventId: string; contentHash: string | null }>> {
  const out = new Map<string, { eventId: string; contentHash: string | null }>()
  if (cellIds.length === 0) return out
  const placeholders = cellIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(
      `SELECT cell_id, event_id, content_hash FROM cells
       WHERE project_id = ? AND side = ? AND cell_id IN (${placeholders})`,
    )
    .bind(ancestorProjectId, side, ...cellIds)
    .all<{ cell_id: string; event_id: string; content_hash: string | null }>()
  for (const r of results) {
    out.set(r.cell_id, { eventId: r.event_id, contentHash: r.content_hash })
  }
  return out
}

/** D's local mirrored source rows for the given cell ids — the pin
 *  (`upstream_event_id`) + its own content_hash, keyed by cell_id. */
async function loadLocalMirrorRows(
  db: AquillaDb,
  projectId: string,
  cellIds: readonly string[],
): Promise<Map<string, { upstreamEventId: string | null; contentHash: string | null }>> {
  const out = new Map<string, { upstreamEventId: string | null; contentHash: string | null }>()
  if (cellIds.length === 0) return out
  const placeholders = cellIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(
      `SELECT cell_id, upstream_event_id, content_hash FROM cells
       WHERE project_id = ? AND side = 'source' AND cell_id IN (${placeholders})`,
    )
    .bind(projectId, ...cellIds)
    .all<{ cell_id: string; upstream_event_id: string | null; content_hash: string | null }>()
  for (const r of results) {
    out.set(r.cell_id, { upstreamEventId: r.upstream_event_id, contentHash: r.content_hash })
  }
  return out
}

/**
 * Ancestor U's own target row's pin (`source_event_id`) vs U's SIBLING
 * source row's head (`event_id`) — the step-2 "side switch": only relevant
 * when D consumes U's TARGET lane, because that's the only case where U's
 * translation-vs-U's-own-source staleness transitively matters to D.
 *
 * No separate hash comparison is needed here (unlike a naive reading of
 * §6 might suggest): this is EXACTLY the same shape as the existing
 * direct-stale query in stale-source-route.ts, one project up — and that
 * query is hash-aware *by construction*, not by an explicit hash join. A
 * content-unchanged upstream edit never advances `s.event_id` (the mirror
 * sync's hash-equal no-op suppression, §5), so `s.event_id` only moves when
 * content actually changed — a plain event-id comparison is already the
 * correct hash-aware signal.
 */
async function loadAncestorTargetPinAndSiblingSource(
  db: AquillaDb,
  ancestorProjectId: string,
  cellIds: readonly string[],
): Promise<Map<string, { targetSourceEventId: string | null; siblingSourceEventId: string }>> {
  const out = new Map<string, { targetSourceEventId: string | null; siblingSourceEventId: string }>()
  if (cellIds.length === 0) return out
  const placeholders = cellIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(
      `SELECT t.cell_id AS cell_id,
              t.source_event_id AS target_source_event_id,
              s.event_id AS sibling_source_event_id
       FROM cells t
       JOIN cells s
         ON s.project_id = t.project_id
        AND s.cell_id    = t.cell_id
        AND s.side       = 'source'
       WHERE t.project_id = ? AND t.side = 'target' AND t.cell_id IN (${placeholders})`,
    )
    .bind(ancestorProjectId, ...cellIds)
    .all<{ cell_id: string; target_source_event_id: string | null; sibling_source_event_id: string }>()
  for (const r of results) {
    out.set(r.cell_id, {
      targetSourceEventId: r.target_source_event_id,
      siblingSourceEventId: r.sibling_source_event_id,
    })
  }
  return out
}

export interface InheritedStalenessResult {
  /** Cell ids (in D's own local id-space — the shared cell_id, §2) whose
   *  ANCESTRY is stale, per the §6 walk. Disjoint in *intent* from
   *  staleCellIds (direct) but a cell can appear in both if useful — the
   *  caller/UI treats inherited as the "your source's source changed" tone,
   *  layered independently of the direct amber flag. */
  upstreamStaleCellIds: string[]
  /** True if ANY ancestor hop in the chain is itself behind its own
   *  upstream (§6 step 3, link-granularity fallback — v1 does not attempt
   *  per-cell precision for this case, per the spec's explicit approximation). */
  ancestorBehind: boolean
}

const EMPTY_RESULT: InheritedStalenessResult = { upstreamStaleCellIds: [], ancestorBehind: false }

/**
 * Compute inherited (ancestor-chain) staleness for the target-side cells of
 * `projectId`/`fileId` that have a local mirrored source row (i.e., this
 * project is itself a live-linked downstream — a self-contained/root
 * project has no ancestors and trivially returns empty).
 *
 * `cellIds` should be the file's cell ids to check (the caller already
 * knows the file's cell set from the direct-stale query's scope; passing it
 * in avoids a redundant full-file cells scan here).
 */
export async function computeUpstreamStaleCellIds(
  env: InheritedStalenessEnv,
  projectId: string,
  cellIds: readonly string[],
): Promise<InheritedStalenessResult> {
  if (cellIds.length === 0) return EMPTY_RESULT

  const chain = await loadLinkChain(env.AQUILLA_PG, projectId)
  // chain[0] is `projectId` itself; need at least one ancestor hop to have
  // anything to inherit.
  if (chain.length < 2) return EMPTY_RESULT

  const staleSet = new Set<string>()
  let ancestorBehind = false

  // D starts as the project under test; walk hop by hop up the chain.
  const dCellIds: string[] = [...cellIds]
  for (let i = 0; i < chain.length - 1; i++) {
    const d = chain[i]!
    const u = chain[i + 1]!
    if (dCellIds.length === 0) break

    // Step 1: mirror check — D's local mirrored source row's
    // upstream_event_id vs U's consumed-lane row head for this cell_id.
    const localMirrors = await loadLocalMirrorRows(env.AQUILLA_PG, d.projectId, dCellIds)
    const ancestorLane = await loadAncestorLaneHead(env.AQUILLA_PG, u.projectId, d.consumes, dCellIds)

    for (const cellId of dCellIds) {
      const local = localMirrors.get(cellId)
      const ancestor = ancestorLane.get(cellId)
      if (!local || !ancestor) continue
      if (local.upstreamEventId == null) continue
      if (local.upstreamEventId === ancestor.eventId) continue
      // Hash-aware: identical content is never stale, even if the event id
      // pin lags (matches the mirror's own no-op suppression, §5/§6).
      const localHash = local.contentHash ?? contentHash("")
      const ancestorHash = ancestor.contentHash ?? contentHash("")
      if (localHash === ancestorHash) continue
      staleSet.add(cellId)
    }

    // Step 2: ancestor pin check (the side switch) — only when D consumes
    // U's TARGET lane. U's own target row may itself be stale against U's
    // sibling source row; if so, that staleness is inherited by D
    // regardless of whether D's mirror of U has caught up yet (the dormant-
    // middle-hop case, §9.4).
    if (d.consumes === "target") {
      const ancestorPins = await loadAncestorTargetPinAndSiblingSource(env.AQUILLA_PG, u.projectId, dCellIds)
      for (const cellId of dCellIds) {
        const pin = ancestorPins.get(cellId)
        if (!pin || pin.targetSourceEventId == null) continue
        if (pin.targetSourceEventId === pin.siblingSourceEventId) continue
        staleSet.add(cellId)
      }
    }

    // Step 3: ancestor-behind fallback (link granularity, v1 approximation
    // per §6/§15 — no per-cell precision attempted here).
    if (u.mode === "live" && u.sourceProjectId) {
      // laneRelevantHeadSeq is imported lazily to avoid a circular import
      // (link-sync.ts doesn't depend on this module, but keeping the
      // require local documents the one-directional dependency clearly).
      const { laneRelevantHeadSeq } = await import("./link-sync")
      const uHead = await laneRelevantHeadSeq(env.AQUILLA_PG, u.sourceProjectId, u.consumes)
      if (uHead > u.cursor) ancestorBehind = true
    }

    // Recurse: U becomes D for the next hop. `dCellIds` (the same original
    // file's cell ids) carries forward unchanged — cell_id is the shared
    // identity across the whole chain (§2), so the next hop's queries
    // (scoped to U as the new D) naturally return nothing for any cell id
    // that doesn't exist in U's own `cells` rows.
  }

  return { upstreamStaleCellIds: [...staleSet], ancestorBehind }
}
