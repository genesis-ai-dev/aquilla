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

  const res = await env.AQUILLA_PG.prepare(
    `SELECT cell_id, audio_id, slot, url, mime_type, voice_id, reference_audio_id,
            duration_ms, label, trim_start_ms, trim_end_ms, target_offset_ms,
              timings_json, selected, created_ts
       FROM cell_audio
      WHERE project_id = ? AND file_id = ? AND deleted = 0
      ORDER BY created_ts ASC`,
  )
    .bind(projectId, fileId)
    .all<AudioRowRaw>()

  const cells = collapseCellAudioRows(res.results ?? [])

  return Response.json({ cells })
}
