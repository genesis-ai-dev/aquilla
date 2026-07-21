// Speaker diarization — async job orchestration (Modal-hosted pyannote 3.1).
//
// Design: docs/superpowers/specs/2026-06-03-diarization-modal-pyannote-design.md
//
// Routes (all under /api/v1/diarization/, so withCors covers the browser ones):
//   POST /api/v1/diarization/start     — user-authed; create job, kick off Modal
//   GET  /api/v1/diarization/status    — user-authed; poll job status + turns
//   GET  /api/v1/diarization/audio     — token-in-URL; Modal fetches the clip
//   POST /api/v1/diarization/callback  — shared-secret; Modal posts turns back
//
// The browser never holds the Modal secret (mirrors voice-convert/Seed-VC). The
// flow is async because an episode takes minutes: `start` spawns the Modal job
// and returns a jobId; Modal POSTs the turns to `callback` when done; the client
// polls `status`. Modal fetches the audio from `audio` (token-gated URL) — it
// can't present a sync-token JWT, so a per-job fetch token guards it instead.
//
// NOTE: callback + audio require the worker to be PUBLICLY reachable (Modal is
// in the cloud). `DIARIZATION_PUBLIC_BASE` is the externally-reachable base URL
// of this worker (incl. any `/sync` apex prefix). Local dev needs a tunnel.

import { timingSafeEqual } from "node:crypto"
import { verifyTokenForFile } from "./auth"
import { audioObjectKey } from "./audio"

// Constant-time compare — a plain `!==` leaks timing information to anyone
// hitting this publicly-reachable callback route.
function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a)
  const bBytes = Buffer.from(b)
  if (aBytes.length !== bBytes.length) return false
  return timingSafeEqual(aBytes, bBytes)
}

export interface DiarizationEnv {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  /** Modal diarization endpoint (infra/modal/diarization.py `start`). */
  DIARIZATION_MODAL_URL?: string
  /** Shared secret authenticating both directions worker↔Modal. */
  DIARIZATION_SHARED_SECRET?: string
  /** Public base URL of THIS worker (incl. /sync prefix in prod) so Modal can
   *  reach the audio + callback routes. */
  DIARIZATION_PUBLIC_BASE?: string
}

interface JobRow {
  id: string
  project_id: string
  file_id: string
  audio_object: string
  fetch_token: string
  status: string
  num_speakers: number | null
  turns_json: string | null
  error: string | null
}

const JSON_HEADERS = { "Content-Type": "application/json" }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

export async function handleDiarizationRequest(
  request: Request,
  env: DiarizationEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const p = url.pathname
  if (!p.startsWith("/api/v1/diarization/")) return null
  if (!env.AQUILLA_PG) return new Response("diarization not configured", { status: 503 })

  if (p === "/api/v1/diarization/start" && request.method === "POST") return start(request, env)
  if (p === "/api/v1/diarization/status" && request.method === "GET") return status(request, env, url)
  if (p === "/api/v1/diarization/audio" && request.method === "GET") return serveAudio(request, env, url)
  if (p === "/api/v1/diarization/callback" && request.method === "POST") return callback(request, env)
  return new Response("not found", { status: 404 })
}

// ── POST /start ────────────────────────────────────────────────────────────
async function start(request: Request, env: DiarizationEnv): Promise<Response> {
  if (!env.DIARIZATION_MODAL_URL || !env.DIARIZATION_SHARED_SECRET || !env.DIARIZATION_PUBLIC_BASE) {
    return new Response("diarization not configured", { status: 503 })
  }
  let body: { projectId?: string; fileId?: string; audioObject?: string; numSpeakers?: number }
  try {
    body = await request.json()
  } catch {
    return new Response("invalid JSON", { status: 400 })
  }
  const { projectId, fileId, audioObject } = body
  if (!projectId || !fileId || !audioObject) {
    return json({ error: "missing projectId, fileId, or audioObject" }, 400)
  }

  // Auth: sync-token scoped to (projectId, fileId), same as /audio + voice-convert.
  const auth = await requireFileToken(request, env, projectId, fileId)
  if (!auth.ok) return auth.response

  const jobId = crypto.randomUUID()
  const fetchToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
  const now = Date.now()
  const numSpeakers = Number.isInteger(body.numSpeakers) && body.numSpeakers! > 0 ? body.numSpeakers! : null

  await env.AQUILLA_PG!.prepare(
    `INSERT INTO diarization_jobs
       (id, project_id, file_id, audio_object, fetch_token, status, num_speakers, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
  )
    .bind(jobId, projectId, fileId, audioObject, fetchToken, numSpeakers, now, now)
    .run()

  const base = env.DIARIZATION_PUBLIC_BASE.replace(/\/+$/, "")
  const audioUrl = `${base}/api/v1/diarization/audio?jobId=${encodeURIComponent(jobId)}&t=${fetchToken}`
  const callbackUrl = `${base}/api/v1/diarization/callback`

  // Kick off Modal. It spawns the GPU job and returns immediately; the turns
  // arrive later via /callback. If Modal is unreachable, fail the job loudly.
  try {
    const res = await fetch(env.DIARIZATION_MODAL_URL, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        secret: env.DIARIZATION_SHARED_SECRET,
        jobId,
        audioUrl,
        callbackUrl,
        numSpeakers,
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      await setStatus(env, jobId, "failed", { error: `modal start ${res.status}: ${detail.slice(0, 200)}` })
      return json({ error: "failed to start diarization" }, 502)
    }
  } catch (e) {
    await setStatus(env, jobId, "failed", { error: `modal unreachable: ${String(e)}` })
    return json({ error: "diarization service unreachable" }, 502)
  }

  await setStatus(env, jobId, "running", {})
  return json({ jobId, status: "running" })
}

// ── GET /status?jobId= ───────────────────────────────────────────────────────
async function status(request: Request, env: DiarizationEnv, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("jobId") ?? ""
  if (!jobId) return json({ error: "missing jobId" }, 400)
  const job = await getJob(env, jobId)
  if (!job) return json({ error: "job not found" }, 404)

  const auth = await requireFileToken(request, env, job.project_id, job.file_id)
  if (!auth.ok) return auth.response

  return json({
    jobId,
    status: job.status,
    ...(job.turns_json ? { turns: JSON.parse(job.turns_json) } : {}),
    ...(job.error ? { error: job.error } : {}),
  })
}

// ── GET /audio?jobId=&t= — Modal fetches the clip (token-gated, no user auth) ──
async function serveAudio(_request: Request, env: DiarizationEnv, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("jobId") ?? ""
  const token = url.searchParams.get("t") ?? ""
  if (!jobId || !token) return new Response("missing jobId or token", { status: 400 })
  const job = await getJob(env, jobId)
  // Constant-ish guard: unknown job or wrong/terminal token → 404 (don't leak).
  if (!job || job.fetch_token !== token) return new Response("not found", { status: 404 })

  const key = audioObjectKey(env, job.project_id, job.file_id, job.audio_object)
  const obj = await env.SNAPSHOTS.get(key)
  if (!obj) return new Response("audio not found", { status: 404 })
  const buf = await obj.arrayBuffer()
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(buf.byteLength),
    },
  })
}

// ── POST /callback — Modal posts turns back (shared-secret auth) ──────────────
async function callback(request: Request, env: DiarizationEnv): Promise<Response> {
  if (
    !env.DIARIZATION_SHARED_SECRET ||
    !constantTimeEqual(request.headers.get("X-Diarization-Secret") ?? "", env.DIARIZATION_SHARED_SECRET)
  ) {
    return new Response("unauthorized", { status: 401 })
  }
  let body: { jobId?: string; status?: string; turns?: unknown; error?: string }
  try {
    body = await request.json()
  } catch {
    return new Response("invalid JSON", { status: 400 })
  }
  if (!body.jobId) return json({ error: "missing jobId" }, 400)
  const job = await getJob(env, body.jobId)
  if (!job) return json({ error: "job not found" }, 404)

  if (body.status === "succeeded") {
    await setStatus(env, body.jobId, "succeeded", { turns: body.turns })
  } else {
    await setStatus(env, body.jobId, "failed", { error: body.error ?? "diarization failed" })
  }
  return json({ ok: true })
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function getJob(env: DiarizationEnv, jobId: string): Promise<JobRow | null> {
  return env
    .AQUILLA_PG!.prepare(`SELECT * FROM diarization_jobs WHERE id = ?`)
    .bind(jobId)
    .first<JobRow>()
}

async function setStatus(
  env: DiarizationEnv,
  jobId: string,
  status: string,
  opts: { turns?: unknown; error?: string },
): Promise<void> {
  await env
    .AQUILLA_PG!.prepare(
      `UPDATE diarization_jobs
         SET status = ?, turns_json = ?, error = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      opts.turns !== undefined ? JSON.stringify(opts.turns) : null,
      opts.error ?? null,
      Date.now(),
      jobId,
    )
    .run()
}

type AuthResult = { ok: true } | { ok: false; response: Response }

async function requireFileToken(
  request: Request,
  env: DiarizationEnv,
  projectId: string,
  fileId: string,
): Promise<AuthResult> {
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return { ok: false, response: new Response(verified.reason, { status: verified.status }) }
  if (verified.claims.projectId !== projectId) {
    return { ok: false, response: new Response("token scoped to different project", { status: 403 }) }
  }
  return { ok: true }
}
