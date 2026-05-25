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
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/audio-attachments$/

interface AudioRowRaw {
  cell_id: string
  audio_id: string
  slot: string
  url: string
  mime_type: string | null
  voice_id: string | null
  reference_audio_id: string | null
  duration_ms: number | null
  timings_json: string | null
  selected: number
  created_ts: number
}

interface AttachmentOut {
  audioId: string
  url: string
  slot: string
  mimeType: string | null
  voiceId: string | null
  referenceAudioId: string | null
  durationMs: number | null
}

interface CellAudioOut {
  attachments: Record<string, AttachmentOut>
  /** Active clip in the "recording" slot. */
  selectedAudioId: string | null
  /** Active clip in the "generatedVoice" slot. */
  selectedGeneratedVoiceAudioId: string | null
  /** Whisper word timings by audioId. */
  audioTimings: Record<string, unknown>
}

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
  if (!env.AQUILLA_DB) {
    return new Response("AQUILLA_DB binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const res = await env.AQUILLA_DB.prepare(
    `SELECT cell_id, audio_id, slot, url, mime_type, voice_id, reference_audio_id,
            duration_ms, timings_json, selected, created_ts
       FROM cell_audio
      WHERE project_id = ? AND file_id = ? AND deleted = 0
      ORDER BY created_ts ASC`,
  )
    .bind(projectId, fileId)
    .all<AudioRowRaw>()

  const cells: Record<string, CellAudioOut> = {}
  for (const r of res.results ?? []) {
    let entry = cells[r.cell_id]
    if (!entry) {
      entry = {
        attachments: {},
        selectedAudioId: null,
        selectedGeneratedVoiceAudioId: null,
        audioTimings: {},
      }
      cells[r.cell_id] = entry
    }
    entry.attachments[r.audio_id] = {
      audioId: r.audio_id,
      url: r.url,
      slot: r.slot,
      mimeType: r.mime_type,
      voiceId: r.voice_id,
      referenceAudioId: r.reference_audio_id,
      durationMs: r.duration_ms,
    }
    if (r.timings_json) {
      try {
        entry.audioTimings[r.audio_id] = JSON.parse(r.timings_json)
      } catch {
        // ignore malformed timings — playback degrades to no karaoke
      }
    }
    if (r.selected === 1) {
      if (r.slot === "recording") entry.selectedAudioId = r.audio_id
      else if (r.slot === "generatedVoice") entry.selectedGeneratedVoiceAudioId = r.audio_id
    }
  }

  return Response.json({ cells })
}
