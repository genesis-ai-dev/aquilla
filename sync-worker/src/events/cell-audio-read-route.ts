// Per-file cell-audio attachment read.
//
//   GET /api/v1/projects/:projectId/files/:fileId/audio-attachments
//
// Returns every live (non-deleted) audio attachment for the file, grouped by
// cell, plus the selected clip per slot. Mirrors the per-file bulk shape of
// the cells read (the editor / Voice Studio pull all attachments at once)
// rather than the per-cell cell_validators read.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — same as the
// cells read.

import { verifyTokenForProject } from "../auth"

export interface CellAudioReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

import { collapseCellAudioRows, type AudioRowRaw } from "./cell-audio-collapse"

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

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

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
      ORDER BY a.created_ts ASC`,
  )
    .bind(projectId, fileId)
    .all<AudioRowRaw>()

  const cells = collapseCellAudioRows(res.results ?? [])

  return Response.json({ cells })
}
