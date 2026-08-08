// Stale-source read route (Phase 5 / AD-9; extended AQU-476 §6).
//
//   GET /api/v1/projects/:projectId/files/:fileId/stale-source
//
// Returns the list of target-side cell ids whose source has advanced
// since the translator last committed. The query is the AD-9 pointer
// comparison from spec 03-data-model §"Source-project linking", now
// HASH-AWARE (AQU-476 §6): a pin whose event id differs but whose
// content_hash matches the current source head is NOT stale — this is
// what lets the mirror sync's no-op suppression (unchanged content keeps
// an old upstream_event_id) stay invisible to the translator.
//
//   SELECT t.cell_id
//   FROM cells t
//   JOIN cells s
//     ON s.project_id = COALESCE(:upstream_project_id, t.project_id)
//    AND s.file_id    = t.file_id
//    AND s.cell_id    = t.cell_id
//    AND s.side       = 'source'
//   WHERE t.project_id      = :project_id
//     AND t.file_id         = :file_id
//     AND t.side            = 'target'
//     AND t.source_event_id IS NOT NULL
//     AND s.event_id        != t.source_event_id
//     AND (
//       pinned.id IS NULL
//       OR s.value IS DISTINCT FROM pinned.payload.value  -- content-aware (§6)
//     )
//
// The upstream project id is resolved from `projects.source_project_id`
// — for linked target projects this points at the upstream; for self-
// contained or source-only projects it is NULL and we COALESCE back to
// the project's own id (so we still detect the rare in-project drift
// case where a target.cell.commit was followed by a same-project
// source.cell.commit).
//
// Clone-mode short-circuit (§2): a clone must NEVER show upstream-drift
// flags — that's the point of cloning. `source_link_mode = 'clone'` skips
// the direct-stale query and returns everything empty/null.
//
// Auth: sync-token JWT scoped to `projectId`. Viewer (100)+ — same gate
// as cells-read; the indicator is purely a read-side derivation.

import { verifyTokenForProject } from "../auth"
import { laneRelevantHeadSeq } from "./link-sync"
import { computeUpstreamStaleCellIds } from "./inherited-staleness"

export interface StaleSourceEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

export interface BehindSeq {
  upstream: number
  cursor: number
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/stale-source$/

export async function handleStaleSourceRequest(
  request: Request,
  env: StaleSourceEnv,
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
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  // 1. Resolve link state (upstream id, mode, cursor). Migration 0050 adds
  // source_link_mode/cursor; if a deployment hasn't applied it yet, the
  // query throws and we fall back to legacy self-contained behavior.
  let upstreamProjectId: string | null = null
  let linkMode: string | null = null
  let linkConsumes: string | null = null
  let linkCursor = 0
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_project_id, source_link_mode, source_link_consumes, source_link_cursor FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{
        source_project_id: string | null
        source_link_mode: string | null
        source_link_consumes: string | null
        source_link_cursor: number | string
      }>()
    upstreamProjectId = row?.source_project_id ?? null
    linkMode = row?.source_link_mode ?? null
    linkConsumes = row?.source_link_consumes ?? null
    linkCursor = Number(row?.source_link_cursor ?? 0)
  } catch {
    // Migration not yet present — fall back to self-contained.
    upstreamProjectId = null
  }
  const consumes = linkConsumes === "target" ? "target" : "source"

  // Clone-mode short-circuit (§2): never show upstream-drift flags.
  if (linkMode === "clone") {
    return Response.json({
      projectId,
      fileId,
      staleCellIds: [],
      tombstonedCellIds: [],
      upstreamStaleCellIds: [],
      upstreamProjectId,
      behindSeq: null,
      ancestorBehind: false,
    })
  }

  // 2. Run the AD-9 pointer comparison, computed LOCALLY against the
  // mirrored source lane (AQU-476 §6) — the mirror sync (link-sync.ts)
  // materializes the upstream's source cells as real local rows with
  // provenance (upstream_event_id/upstream_seq), so a target's
  // source_event_id pin (always a same-project id — set from the LOCAL
  // source row's event_id at commit time, per target.cell.commit's
  // projection) is compared against the LOCAL mirrored row, never a
  // cross-project row. This replaces the pre-AQU-476 cross-project JOIN,
  // which compared a same-project pin against the upstream's OWN event ids
  // — a mismatch by construction once mirrored rows carry deterministic
  // mirror event ids distinct from the upstream's.
  //
  // Hash-aware (§6): compare the current source text with the source event
  // named by the target's pin. Re-import can legitimately advance a source
  // row for metadata, structure, or lossless-formatting changes while leaving
  // its translatable text untouched. Event-id comparison alone incorrectly
  // marked those cells stale (notably IDML milestone metadata backfills).
  //
  // The projection's content_hash fingerprints plain `value`, so comparing
  // the pinned event payload's value to the current projected value is the
  // equivalent content-aware check without adding a duplicated hash column to
  // every target row. A missing pinned event remains stale defensively.
  //
  // AQU-646: the comparison is on the cell's EFFECTIVE source text, not its
  // stored value, because for an imported media segment `value` is the audio
  // FILENAME and the transcript is what anyone translates. Correcting such a
  // transcript leaves the filename identical on both sides, so a value-only
  // comparison filtered the row out and the translator was never told the
  // source had changed — a regression the moment those corrections stopped
  // overwriting `value` (which is exactly what they should stop doing).
  const sql = `
    SELECT t.cell_id AS cell_id
    FROM cells t
    JOIN cells s
      ON s.project_id = t.project_id
     AND s.file_id    = t.file_id
     AND s.cell_id    = t.cell_id
     AND s.side       = 'source'
    LEFT JOIN events pinned
      ON pinned.project_id = t.project_id
     AND pinned.id         = t.source_event_id
    WHERE t.project_id      = ?
      AND t.file_id         = ?
      AND t.side            = 'target'
      AND t.source_event_id IS NOT NULL
      AND s.event_id        != t.source_event_id
      AND s.tombstoned_at IS NULL
      AND (
        pinned.id IS NULL
        OR COALESCE(NULLIF(s.transcription, ''), s.value)
             IS DISTINCT FROM COALESCE(
               NULLIF((pinned.payload::jsonb)->>'transcription', ''),
               (pinned.payload::jsonb)->>'value',
               ''
             )
      )
  `

  let staleCellIds: string[] = []
  try {
    const res = await env.AQUILLA_PG.prepare(sql)
      .bind(projectId, fileId)
      .all<{ cell_id: string }>()
    staleCellIds = (res.results ?? []).map((r) => r.cell_id)
  } catch (err) {
    // Defensive: if the cells projection isn't fully shaped yet (e.g.,
    // a migration not applied), the query fails on a missing column.
    // Return an empty list rather than 500 — staleness is a soft signal,
    // the editor must not break on its absence.
    console.warn("stale-source query failed:", err)
    staleCellIds = []
  }

  // 3. Tombstoned cells (AQU-476 §5): upstream deleted this line — the
  // downstream's local source row is kept (never deleted) so the orphaned
  // target stays visible; `tombstoned_at` flags it here for the review UI.
  let tombstonedCellIds: string[] = []
  try {
    const res = await env.AQUILLA_PG.prepare(
      `SELECT cell_id FROM cells
       WHERE project_id = ? AND file_id = ? AND side = 'source' AND tombstoned_at IS NOT NULL`,
    )
      .bind(projectId, fileId)
      .all<{ cell_id: string }>()
    tombstonedCellIds = (res.results ?? []).map((r) => r.cell_id)
  } catch (err) {
    console.warn("tombstoned-cells query failed:", err)
    tombstonedCellIds = []
  }

  // 4. behindSeq (§6): link-level "you have unmirrored changes" — non-null
  // iff this is a live link AND the upstream has lane-relevant changes past
  // the mirrored cursor. Comments/audio/validation-only upstream activity
  // never counts (laneRelevantHeadSeq only looks at mirrored kinds).
  let behindSeq: BehindSeq | null = null
  if (upstreamProjectId && linkMode === "live") {
    try {
      const head = await laneRelevantHeadSeq(env.AQUILLA_PG, upstreamProjectId, consumes)
      if (head > linkCursor) {
        behindSeq = { upstream: head, cursor: linkCursor }
      }
    } catch (err) {
      console.warn("behindSeq probe failed:", err)
      behindSeq = null
    }
  }

  // 5. Inherited staleness (AQU-477 §6): the per-hop chain walk. Only
  // relevant for live-linked projects with at least one ancestor hop above
  // the immediate upstream — a direct (single-hop) link has nothing to
  // inherit (its own staleCellIds query above already covers that case).
  // Scoped to this file's cell ids (reuses whatever cell set the direct
  // query already touched, via a plain file-scoped id read) so the walk
  // never scans the whole project.
  let upstreamStaleCellIds: string[] = []
  let ancestorBehind = false
  if (upstreamProjectId && linkMode === "live") {
    try {
      const fileCellIdsRes = await env.AQUILLA_PG.prepare(
        `SELECT DISTINCT cell_id FROM cells WHERE project_id = ? AND file_id = ?`,
      )
        .bind(projectId, fileId)
        .all<{ cell_id: string }>()
      const fileCellIds = (fileCellIdsRes.results ?? []).map((r) => r.cell_id)
      const inherited = await computeUpstreamStaleCellIds({ AQUILLA_PG: env.AQUILLA_PG }, projectId, fileCellIds)
      upstreamStaleCellIds = inherited.upstreamStaleCellIds
      ancestorBehind = inherited.ancestorBehind
    } catch (err) {
      console.warn("upstream-stale (inherited) query failed:", err)
      upstreamStaleCellIds = []
    }
  }

  return Response.json({
    projectId,
    fileId,
    staleCellIds,
    tombstonedCellIds,
    upstreamStaleCellIds,
    upstreamProjectId,
    behindSeq,
    ancestorBehind,
  })
}
