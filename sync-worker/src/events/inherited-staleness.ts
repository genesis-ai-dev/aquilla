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
//      own no-op suppression, §5). Gate-aware: a link that takes only
//      validated text does not count an unvalidated upstream head.
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
//
// AQU-1683, two rules that keep the walk from flagging what will never clear:
//
//   - A file linked straight to a project with no live link of its own has
//     nothing to inherit. A change in that upstream reaches the file as
//     direct staleness once the mirror syncs, so the walk reports nothing
//     until there is a second ancestor.
//   - Every read is scoped to the file pair the hop's link mirrors. cell_id is
//     shared along the chain but NOT unique within a project: IDML cell ids
//     are story paths that every IDML file repeats, and a read by cell_id
//     alone compared a line with another file's line of the same id.
//
// AQU-1644: a target-consumption hop reads only the lane the link follows
// (`source_link_lane_id`). An edit on another of the ancestor's lanes is not
// a change this downstream will receive.

import { contentHash } from "./event-projection"
import { deterministicDownstreamFileId, isUndefinedColumn, laneRelevantHeadSeq } from "./link-sync"
import { parseSourceLinkAdoption } from "../../../db/shared/source-link-adopt"

const MAX_HOPS = 32

export interface InheritedStalenessEnv {
  AQUILLA_PG: AquillaDb
}

interface LinkChainLink {
  projectId: string
  sourceProjectId: string | null
  mode: string | null
  consumes: "source" | "target"
  /** AQU-1683: 'head' or 'validated' — what link-sync mirrors of a target
   *  lane. Anything but 'head' is 'validated', as link-sync reads it. */
  gate: "head" | "validated"
  cursor: number
  /** Upstream lane this hop consumes. Null means the ancestor's `legacy_tag = ''` lane. */
  laneId: string | null
}

/** A target lane this hop's queries are pinned to. `id` may be empty when the
 *  '' lane has no row yet; rows that lack `lane_id` then match on `tag`. */
export interface ConsumedTargetLane {
  id: string
  tag: string
}

/** Load one project's link row (id, upstream, mode, consumes, gate, cursor). */
async function loadLinkChainLink(db: AquillaDb, projectId: string): Promise<LinkChainLink | null> {
  const row = await db
    .prepare(
      `SELECT source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor
       FROM projects WHERE id = ?`,
    )
    .bind(projectId)
    .first<{
      source_project_id: string | null
      source_link_mode: string | null
      source_link_consumes: string | null
      source_link_gate: string | null
      source_link_cursor: number | string
    }>()
  if (!row) return null
  // AQU-1644: the consumed lane (migration 0138) is its own statement so a
  // database that predates the column still walks the '' lane. Only 42703 is
  // that case — a missing `source_link_adopt` column must not land here.
  let laneId: string | null = null
  try {
    const lane = await db
      .prepare("SELECT source_link_lane_id FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ source_link_lane_id: string | null }>()
    laneId = lane?.source_link_lane_id ?? null
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err
  }
  return {
    projectId,
    sourceProjectId: row.source_project_id,
    mode: row.source_link_mode,
    consumes: row.source_link_consumes === "target" ? "target" : "source",
    gate: row.source_link_gate === "head" ? "head" : "validated",
    cursor: Number(row.source_link_cursor ?? 0),
    laneId,
  }
}

/** NULL `source_link_lane_id` is the ancestor's `legacy_tag = ''` target lane.
 *  A stored id that is not a target lane of that ancestor matches nothing. */
export async function resolveConsumedTargetLane(
  db: AquillaDb,
  ancestorProjectId: string,
  laneId: string | null,
): Promise<ConsumedTargetLane> {
  if (!laneId) {
    const row = await db
      .prepare(
        `SELECT id FROM lanes
          WHERE project_id = ? AND role = 'target' AND legacy_tag = ''`,
      )
      .bind(ancestorProjectId)
      .first<{ id: string }>()
    return { id: row?.id ?? "", tag: "" }
  }
  const row = await db
    .prepare(
      `SELECT id, legacy_tag FROM lanes
        WHERE id = ? AND project_id = ? AND role = 'target'`,
    )
    .bind(laneId, ancestorProjectId)
    .first<{ id: string; legacy_tag: string | null }>()
  if (!row || row.legacy_tag === null) return { id: laneId, tag: "\u0000" }
  return { id: row.id, tag: row.legacy_tag }
}

/** Prefer `lane_id`. Rows that have none still match the legacy tag. */
function targetLaneSql(alias: string): string {
  const p = alias ? `${alias}.` : ""
  return `(
    (${p}lane_id IS NOT NULL AND ${p}lane_id <> '' AND ${p}lane_id = ?)
    OR ((${p}lane_id IS NULL OR ${p}lane_id = '') AND ${p}target_lang = ?)
  )`
}

/**
 * AQU-1683: the upstream file that `link`'s project mirrors into `fileId`, or
 * null when `fileId` is the project's own file and follows nothing upstream.
 * The same identity link-sync writes: a file the lead chose to have the link
 * replace (AQU-1679, `consumes = 'source'` only) is named in
 * `source_link_adopt`; every other mirrored file has the id
 * `deterministicDownstreamFileId` derives from the upstream file's.
 */
async function loadUpstreamFileId(
  db: AquillaDb,
  link: LinkChainLink,
  upstreamProjectId: string,
  fileId: string,
): Promise<string | null> {
  if (link.consumes === "source") {
    // Migration 0140, its own statement. Unreadable = no file adopted, as
    // link-sync reads it — a missing lane column is not this read.
    let adopted: Record<string, string>
    try {
      const row = await db
        .prepare("SELECT source_link_adopt FROM projects WHERE id = ?")
        .bind(link.projectId)
        .first<{ source_link_adopt: string | null }>()
      adopted = parseSourceLinkAdoption(row?.source_link_adopt)?.files ?? {}
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err
      adopted = {}
    }
    for (const [upstreamFileId, ownFileId] of Object.entries(adopted)) {
      if (ownFileId === fileId) return upstreamFileId
    }
  }
  const { results } = await db
    .prepare("SELECT id FROM files WHERE project_id = ?")
    .bind(upstreamProjectId)
    .all<{ id: string }>()
  return results.find((f) => deterministicDownstreamFileId(link.projectId, f.id) === fileId)?.id ?? null
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
 *  ancestor's TARGET row (the lane D actually mirrors). Scoped to the
 *  ancestor's file the hop mirrors (AQU-1683) and, for a target row, to the
 *  lane the link follows (AQU-1644). */
async function loadAncestorLaneHead(
  db: AquillaDb,
  ancestorProjectId: string,
  ancestorFileId: string,
  side: "source" | "target",
  cellIds: readonly string[],
  /** Target rows only. Source rows are the one source lane (`target_lang ''`). */
  lane: ConsumedTargetLane | null,
): Promise<Map<string, { eventId: string; contentHash: string | null; validated: boolean }>> {
  const out = new Map<string, { eventId: string; contentHash: string | null; validated: boolean }>()
  if (cellIds.length === 0) return out
  const placeholders = cellIds.map(() => "?").join(", ")
  const laneSql = side === "target" && lane ? ` AND ${targetLaneSql("")}` : ""
  const binds: unknown[] = [ancestorProjectId, ancestorFileId, side, ...cellIds]
  if (side === "target" && lane) binds.push(lane.id, lane.tag)
  const { results } = await db
    .prepare(
      `SELECT cell_id, event_id, content_hash, validated FROM cells
       WHERE project_id = ? AND file_id = ? AND side = ? AND cell_id IN (${placeholders})${laneSql}`,
    )
    .bind(...binds)
    .all<{ cell_id: string; event_id: string; content_hash: string | null; validated: number | boolean }>()
  for (const r of results) {
    out.set(r.cell_id, { eventId: r.event_id, contentHash: r.content_hash, validated: Boolean(r.validated) })
  }
  return out
}

/** D's local mirrored source rows for the given cell ids in one file — the
 *  pin (`upstream_event_id`) + its own content_hash, keyed by cell_id. */
async function loadLocalMirrorRows(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellIds: readonly string[],
): Promise<Map<string, { upstreamEventId: string | null; contentHash: string | null }>> {
  const out = new Map<string, { upstreamEventId: string | null; contentHash: string | null }>()
  if (cellIds.length === 0) return out
  const placeholders = cellIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(
      `SELECT cell_id, upstream_event_id, content_hash FROM cells
       WHERE project_id = ? AND file_id = ? AND side = 'source' AND cell_id IN (${placeholders})`,
    )
    .bind(projectId, fileId, ...cellIds)
    .all<{ cell_id: string; upstream_event_id: string | null; content_hash: string | null }>()
  for (const r of results) {
    out.set(r.cell_id, { upstreamEventId: r.upstream_event_id, contentHash: r.content_hash })
  }
  return out
}

/**
 * The cells whose ancestor U's own target row is stale against U's SIBLING
 * source row (same file, same cell_id, the consumed lane) — the step-2 "side
 * switch": only relevant when D consumes U's TARGET lane, because that's the
 * only case where U's translation-vs-U's-own-source staleness transitively
 * matters to D.
 *
 * The same comparison as the direct-stale query in stale-source-route.ts, one
 * project up, and it has to be content-aware for the same reason (AQU-1683):
 * a source row's `event_id` moves on changes that leave its text alone — a
 * re-import touching only metadata, structure or lossless formatting — and an
 * event-id comparison alone reported every translation older than that as
 * stale for good. So a moved pin is stale only when the source's effective
 * text (the transcript of a media segment, else `value`) differs from the
 * pinned event's, or the pinned event is missing. A tombstoned source row is
 * reported as deleted downstream, never as stale. Scoped to the lane the link
 * follows (AQU-1644): another lane's stale translation is not this hop's.
 */
async function loadAncestorTargetsStaleAgainstOwnSource(
  db: AquillaDb,
  ancestorProjectId: string,
  ancestorFileId: string,
  cellIds: readonly string[],
  lane: ConsumedTargetLane,
): Promise<Set<string>> {
  const out = new Set<string>()
  if (cellIds.length === 0) return out
  const placeholders = cellIds.map(() => "?").join(", ")
  const { results } = await db
    .prepare(
      `SELECT t.cell_id AS cell_id
       FROM cells t
       JOIN cells s
         ON s.project_id = t.project_id
        AND s.file_id    = t.file_id
        AND s.cell_id    = t.cell_id
        AND s.side       = 'source'
       LEFT JOIN events pinned
         ON pinned.project_id = t.project_id
        AND pinned.id         = t.source_event_id
       WHERE t.project_id = ? AND t.file_id = ? AND t.side = 'target' AND t.cell_id IN (${placeholders})
         AND ${targetLaneSql("t")}
         AND t.source_event_id IS NOT NULL
         AND s.event_id != t.source_event_id
         AND s.tombstoned_at IS NULL
         AND (
           pinned.id IS NULL
           OR COALESCE(NULLIF(s.transcription, ''), s.value)
                IS DISTINCT FROM COALESCE(
                  NULLIF((pinned.payload::jsonb)->>'transcription', ''),
                  (pinned.payload::jsonb)->>'value',
                  ''
                )
         )`,
    )
    .bind(ancestorProjectId, ancestorFileId, ...cellIds, lane.id, lane.tag)
    .all<{ cell_id: string }>()
  for (const r of results) out.add(r.cell_id)
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
 * Compute inherited (ancestor-chain) staleness for the cells of
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
  fileId: string,
  cellIds: readonly string[],
): Promise<InheritedStalenessResult> {
  if (cellIds.length === 0) return EMPTY_RESULT

  const chain = await loadLinkChain(env.AQUILLA_PG, projectId)
  // chain[0] is `projectId` itself and chain[1] its upstream. AQU-1683: an
  // upstream with no live link of its own leaves nothing to inherit — a
  // change there reaches this file as direct staleness once the mirror
  // syncs — so the walk needs a second ancestor before it reports anything.
  if (chain.length < 3) return EMPTY_RESULT

  const staleSet = new Set<string>()
  let ancestorBehind = false

  // D starts as the project under test; walk hop by hop up the chain.
  const dCellIds: string[] = [...cellIds]
  // AQU-1683: the file D's rows are read from at this hop. Null once a hop's
  // file follows nothing upstream (D's own file), which ends the per-cell
  // checks; the link-level step 3 still runs for every hop.
  let dFileId: string | null = fileId
  for (let i = 0; i < chain.length - 1; i++) {
    const d = chain[i]
    const u = chain[i + 1]
    if (dCellIds.length === 0) break

    const uFileId: string | null =
      dFileId == null ? null : await loadUpstreamFileId(env.AQUILLA_PG, d, u.projectId, dFileId)
    if (dFileId != null && uFileId != null) {
      // Step 1: mirror check — D's local mirrored source row's
      // upstream_event_id vs U's consumed-lane row head for this cell_id.
      const localMirrors = await loadLocalMirrorRows(env.AQUILLA_PG, d.projectId, dFileId, dCellIds)
      // AQU-1644: the lane D consumes of U. NULL is U's '' lane. Without this,
      // an edit on another of U's target lanes overwrites the map entry and
      // flags D stale for a lane it does not follow.
      const consumedLane =
        d.consumes === "target"
          ? await resolveConsumedTargetLane(env.AQUILLA_PG, u.projectId, d.laneId)
          : null
      const ancestorLane = await loadAncestorLaneHead(
        env.AQUILLA_PG,
        u.projectId,
        uFileId,
        d.consumes,
        dCellIds,
        consumedLane,
      )
      // A link that takes only validated text mirrors nothing while U's head
      // is an unvalidated draft (link-sync.ts loadDeltaTargetConsumption), so
      // that head is not a change D will receive (AQU-1683).
      const validatedOnly = d.consumes === "target" && d.gate === "validated"

      for (const cellId of dCellIds) {
        const local = localMirrors.get(cellId)
        const ancestor = ancestorLane.get(cellId)
        if (!local || !ancestor) continue
        if (local.upstreamEventId == null) continue
        if (local.upstreamEventId === ancestor.eventId) continue
        if (validatedOnly && !ancestor.validated) continue
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
      if (d.consumes === "target" && consumedLane) {
        const stale = await loadAncestorTargetsStaleAgainstOwnSource(
          env.AQUILLA_PG,
          u.projectId,
          uFileId,
          dCellIds,
          consumedLane,
        )
        for (const cellId of stale) staleSet.add(cellId)
      }
    }

    // Step 3: ancestor-behind fallback (link granularity, v1 approximation
    // per §6/§15 — no per-cell precision attempted here).
    if (u.mode === "live" && u.sourceProjectId) {
      // U's own consumed lane. An edit on a lane U does not follow must not
      // mark the chain behind.
      const uLane =
        u.consumes === "target"
          ? await resolveConsumedTargetLane(env.AQUILLA_PG, u.sourceProjectId, u.laneId)
          : null
      const uHead = await laneRelevantHeadSeq(
        env.AQUILLA_PG,
        u.sourceProjectId,
        u.consumes,
        uLane ?? undefined,
      )
      if (uHead > u.cursor) ancestorBehind = true
    }

    // Recurse: U becomes D for the next hop, reading the file D's file
    // mirrors. `dCellIds` (the same original file's cell ids) carries forward
    // unchanged — cell_id is the shared identity across the whole chain (§2),
    // so the next hop's queries (scoped to U as the new D) naturally return
    // nothing for any cell id that doesn't exist in U's own `cells` rows.
    dFileId = uFileId
  }

  return { upstreamStaleCellIds: [...staleSet], ancestorBehind }
}
