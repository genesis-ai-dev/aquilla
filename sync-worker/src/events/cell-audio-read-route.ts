// Per-file cell-audio attachment read.
//
//   GET /api/v1/projects/:projectId/files/:fileId/audio-attachments
//
// Returns every live (non-deleted) audio attachment for the file, grouped by
// cell, plus the selected clip per slot. Mirrors the per-file bulk shape of
// the cells read (the editor / Voice Studio pull all attachments at once)
// rather than the per-cell cell_validators read.
//
// Query:
//   lane=<tag>  — AQU-1591: optional. When present, only the takes that lane
//                 can see come back: its own dubs, plus the shared programme
//                 audio (`role = 'source'`), which is the source side of the
//                 line and belongs to every lane the way source TEXT does.
//                 Absent = every lane's takes, byte-identical to pre-1591 —
//                 which is what the export paths and any older client send.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — same as the
// cells read. AQU-730: when the read wall is on, a requested lane must be one
// the caller was granted, and an unscoped read returns only granted lanes'
// dubs plus the shared programme audio.

import { verifyTokenForProject } from "../auth"

export interface CellAudioReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  /** AQU-730: "1" enforces lane grants on this read. Unset = every lane. */
  LANE_READ_WALL?: string
}

import { collapseCellAudioRows, type AudioRowRaw } from "./cell-audio-collapse"
import { audioLaneDualReadBinds, audioLaneDualReadSql } from "./lane-id-sql"
import {
  canReadRequestedLane,
  grantedLaneIds,
  targetVisibilityClause,
  visibleLanesForRead,
} from "./lane-read-wall"

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/audio-attachments$/



export async function handleCellAudioReadRequest(
  request: Request,
  env: CellAudioReadEnv,
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

  // AQU-1591. `lane` is read with `has`, not truthiness: `?lane=` names the
  // DEFAULT lane (legacy_tag ''), which is a real lane and a different request
  // from "every lane". The cells read spells the absent case the same way.
  const laneRequested = url.searchParams.has("lane")
  const lane = url.searchParams.get("lane") ?? ""
  const laneFilterSql = laneRequested ? `AND ${audioLaneDualReadSql("a")}` : ""
  const laneFilterBinds = laneRequested ? audioLaneDualReadBinds(projectId, lane) : []

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const visibleLanes = visibleLanesForRead(env.LANE_READ_WALL, auth.claims)
  if (laneRequested && !(await canReadRequestedLane(env.AQUILLA_PG, projectId, visibleLanes, lane))) {
    return Response.json({ cells: {} }, { headers: { "Cache-Control": "private, no-store" } })
  }
  // A dub with no lane_id yet is the '' lane's, as in audioLaneDualReadSql.
  const wall = targetVisibilityClause({
    laneIds: await grantedLaneIds(env.AQUILLA_PG, projectId, visibleLanes),
    sideExpr: "a.role",
    laneIdExpr: `COALESCE(a.lane_id, (SELECT id FROM public.lanes
                   WHERE project_id = a.project_id AND role = 'target' AND legacy_tag = ''))`,
  })

  // AQU-490: the votes come back in the SAME statement, aggregated in a
  // lateral rather than joined. A plain join to cell_audio_validators would
  // return one row per (take, validator) and every take with two validators
  // would arrive twice — which the collapse below would quietly tolerate,
  // since it keys attachments by audio_id and the last row would simply win.
  // The bug would surface as nothing at all until somebody read a duration.
  const res = await env.AQUILLA_PG.prepare(
    `SELECT a.cell_id, a.audio_id, a.slot, a.url, a.mime_type, a.voice_id,
            a.reference_audio_id, a.duration_ms, a.label, a.trim_start_ms,
            a.trim_end_ms, a.target_offset_ms, a.timings_json, a.selected,
            a.created_ts, a.validator_count, a.role, a.created_by,
            COALESCE(v.names, ARRAY[]::text[]) AS validators
       FROM cell_audio a
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(cav.username ORDER BY cav.decided_ts DESC) AS names
           FROM cell_audio_validators cav
          WHERE cav.project_id = a.project_id AND cav.file_id = a.file_id
            AND cav.cell_id = a.cell_id AND cav.audio_id = a.audio_id
       ) v ON TRUE
      WHERE a.project_id = ? AND a.file_id = ? AND a.deleted = 0
        ${laneFilterSql}
        ${wall?.sql ?? ""}
      ORDER BY a.created_ts ASC`,
  )
    .bind(projectId, fileId, ...laneFilterBinds, ...(wall?.binds ?? []))
    .all<AudioRowRaw>()

  const cells = collapseCellAudioRows(res.results ?? [])

  return Response.json({ cells })
}
