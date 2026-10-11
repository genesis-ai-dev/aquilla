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
//
// AQU-1855: nothing guarantees the callback arrives. Modal's container timeout
// kills the GPU job outright, so the `except` branch that reports a failure
// never runs, and a callback can also be lost to a worker restart or a network
// failure the Modal side exhausts its retries on. A job whose callback never
// lands used to sit at `running` for good, and the client polled it forever.
// Two guards, both here:
//
//   * the SWEEP (`reapStaleJobs`) fails any job that has been live longer than
//     DIARIZATION_STALE_MS, which is past the point Modal itself gave up. It
//     runs from `/start` and from a `/status` poll that finds its own job
//     overdue, rather than on a cron, because this worker has no scheduled
//     handler; a job nobody polls therefore stays `running` in the table until
//     the next `/start` in any project sweeps it, which is soon enough for the
//     only two things that read it (the poller, and the cap below).
//   * the CAP bounds how many live jobs one user and one project may hold, so a
//     lost callback (or a user mashing the button) cannot pin the GPU pool.
//     Modal enforces the matching ceiling on its side via `max_containers`
//     (infra/modal/diarization.py).

import { verifyTokenForFile, WRITE_ROLE_LEVEL, type SyncTokenClaims } from "./auth"
import { audioObjectKey, isPathSafeId, safeAudioContentType } from "./audio"
import { secureCompare as constantTimeEqual } from "./lib/secure-compare"

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
  created_by: number | null
  updated_at: number | string
}

const JSON_HEADERS = { "Content-Type": "application/json" }

/** The statuses a job can still move out of on its own (a callback can arrive). */
const LIVE_STATUSES = ["queued", "running"] as const

/**
 * AQU-1855: how long a job may stay live before the sweep calls it failed.
 *
 * Modal's own ceiling is 1800 s (`timeout=1800` on the Diarizer class), and a
 * container killed at that ceiling sends nothing — so anything still live well
 * past it is never going to report. 35 minutes leaves the Modal side its full
 * half hour plus slack for a slow callback and its retries, and still bounds
 * the job far inside the "forever" this ticket is about.
 */
export const DIARIZATION_STALE_MS = 35 * 60_000

/** The error a swept job carries. User-facing: the UI shows it and re-enables
 *  Diarize, so running the action again is the retry. */
export const DIARIZATION_TIMEOUT_ERROR =
  "diarization timed out — the speaker-detection job stopped reporting. Try again."

/** AQU-1855: live diarization jobs one user may hold at once. */
export const DIARIZATION_MAX_LIVE_PER_USER = 2

/** AQU-1855: live diarization jobs one project may hold at once, across users.
 *  Matches `max_containers` on the Modal app so one project cannot take the
 *  whole GPU pool. */
export const DIARIZATION_MAX_LIVE_PER_PROJECT = 4

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
  // audioObject is a JSON-body field (unlike /audio, whose ids are URL-path
  // segments) and lands directly in an R2 key via audioObjectKey — see
  // audio.ts's isPathSafeId doc comment. Reject anything that could act as a
  // path separator there.
  if (!isPathSafeId(audioObject)) {
    return json({ error: "invalid audioObject" }, 400)
  }

  // Auth: sync-token scoped to (projectId, fileId), same as /audio + voice-convert.
  // Starting a job spends real GPU money, so require the same CONTRIBUTOR
  // floor as the equivalent cell.audio.attach event — a viewer/commenter/
  // reviewer token can poll status but must not be able to trigger billed work.
  const auth = await requireFileToken(request, env, projectId, fileId, { minRole: WRITE_ROLE_LEVEL })
  if (!auth.ok) return auth.response

  // AQU-1855: sweep first, so a job abandoned by a lost callback does not hold
  // a slot in the cap below, and only then count what is genuinely still live.
  await reapStaleJobs(env)
  const overCap = await liveJobCapExceeded(env, projectId, auth.claims.userId)
  if (overCap) return json({ error: overCap }, 429)

  const jobId = crypto.randomUUID()
  const fetchToken = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
  const now = Date.now()
  const numSpeakers = Number.isInteger(body.numSpeakers) && body.numSpeakers! > 0 ? body.numSpeakers! : null

  await env.AQUILLA_PG!.prepare(
    `INSERT INTO diarization_jobs
       (id, project_id, file_id, audio_object, fetch_token, status, num_speakers, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  )
    .bind(jobId, projectId, fileId, audioObject, fetchToken, numSpeakers, auth.claims.userId, now, now)
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
  let job = await getJob(env, jobId)
  if (!job) return json({ error: "job not found" }, 404)

  const auth = await requireFileToken(request, env, job.project_id, job.file_id)
  if (!auth.ok) return auth.response

  // AQU-1855: the poll is where a client learns its job is dead, so a job that
  // has stopped reporting is swept HERE and answers `failed` rather than
  // `running` forever. Only when this job is itself overdue: the client polls
  // every couple of seconds, and a sweep on every poll would be a write per
  // tick to tell us what the row already says. Behind the token check, so a
  // caller with no claim on the job cannot provoke the write.
  if (isStaleLive(job, Date.now())) {
    await reapStaleJobs(env)
    job = (await getJob(env, jobId)) ?? job
  }

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
  // Unknown job or wrong/terminal token → 404 (don't leak); constant-time compare.
  if (!job || !job.fetch_token || !constantTimeEqual(job.fetch_token, token)) return new Response("not found", { status: 404 })

  const key = audioObjectKey(env, job.project_id, job.file_id, job.audio_object)
  const obj = await env.SNAPSHOTS.get(key)
  if (!obj) return new Response("audio not found", { status: 404 })
  // AQU-1855: hand Modal the R2 body as a STREAM. This used to `arrayBuffer()`
  // the whole object, so a feature-length recording was held in the isolate
  // entire — one fetch of a large clip could exhaust the 128 MB limit, and two
  // concurrent ones reliably did. `obj.size` comes from R2's metadata, so the
  // Content-Length is still exact without reading a byte.
  return new Response(obj.body, {
    status: 200,
    headers: {
      // [Pen test] Input validation & injection (2026-08-26): same deny-list
      // fix as /audio — this reads the identical R2 objects, so it needs the
      // same defense-in-depth against a pre-fix or otherwise mislabeled object.
      "Content-Type": safeAudioContentType(obj.httpMetadata?.contentType),
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(obj.size),
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

/** AQU-1855: is this job one the sweep would fail? Same predicate as
 *  `reapStaleJobs`' WHERE clause, for deciding whether to run it at all. */
function isStaleLive(job: JobRow, now: number): boolean {
  return (
    (LIVE_STATUSES as readonly string[]).includes(job.status) &&
    Number(job.updated_at) <= now - DIARIZATION_STALE_MS
  )
}

/**
 * AQU-1855: fail every job that has been live longer than DIARIZATION_STALE_MS.
 *
 * One indexed UPDATE over `(status, updated_at)`, no read first: the WHERE is
 * the whole decision, so a job a callback finished a millisecond earlier is
 * untouched (it is no longer live) and the sweep can never overwrite a real
 * result. `updated_at` is the job's last transition — `queued` → `running`
 * bumps it — so the clock starts when Modal accepted the work.
 *
 * Returns how many jobs it failed, which the tests assert on.
 */
export async function reapStaleJobs(env: DiarizationEnv, now: number = Date.now()): Promise<number> {
  const res = await env
    .AQUILLA_PG!.prepare(
      `UPDATE diarization_jobs
          SET status = 'failed', error = ?, updated_at = ?
        WHERE status IN (${LIVE_STATUSES.map(() => "?").join(", ")})
          AND updated_at <= ?`,
    )
    .bind(DIARIZATION_TIMEOUT_ERROR, now, ...LIVE_STATUSES, now - DIARIZATION_STALE_MS)
    .run()
  return res.meta.changes
}

/**
 * AQU-1855: the message to refuse a `start` with, or null when the caller is
 * under both caps. Counts only live jobs, and only after a sweep — an
 * abandoned job must not cost a user their slot forever.
 */
async function liveJobCapExceeded(
  env: DiarizationEnv,
  projectId: string,
  userId: number,
): Promise<string | null> {
  const placeholders = LIVE_STATUSES.map(() => "?").join(", ")
  const row = await env
    .AQUILLA_PG!.prepare(
      `SELECT
         COUNT(*) FILTER (WHERE project_id = ?) AS project_live,
         COUNT(*) FILTER (WHERE created_by = ?) AS user_live
       FROM diarization_jobs
       WHERE status IN (${placeholders})
         AND (project_id = ? OR created_by = ?)`,
    )
    .bind(projectId, userId, ...LIVE_STATUSES, projectId, userId)
    .first<{ project_live: number | string; user_live: number | string }>()
  const userLive = Number(row?.user_live ?? 0)
  const projectLive = Number(row?.project_live ?? 0)
  if (userLive >= DIARIZATION_MAX_LIVE_PER_USER) {
    return `you already have ${userLive} speaker-detection job(s) running; wait for one to finish before starting another`
  }
  if (projectLive >= DIARIZATION_MAX_LIVE_PER_PROJECT) {
    return `this project already has ${projectLive} speaker-detection job(s) running; wait for one to finish before starting another`
  }
  return null
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

type AuthResult = { ok: true; claims: SyncTokenClaims } | { ok: false; response: Response }

async function requireFileToken(
  request: Request,
  env: DiarizationEnv,
  projectId: string,
  fileId: string,
  opts?: { minRole?: number },
): Promise<AuthResult> {
  const header = request.headers.get("Authorization") ?? ""
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
  const verified = await verifyTokenForFile(token, fileId, env.SYNC_SECRET_KEY)
  if (!verified.ok) return { ok: false, response: new Response(verified.reason, { status: verified.status }) }
  if (verified.claims.projectId !== projectId) {
    return { ok: false, response: new Response("token scoped to different project", { status: 403 }) }
  }
  if (opts?.minRole != null && verified.claims.role < opts.minRole) {
    return { ok: false, response: new Response("insufficient role", { status: 403 }) }
  }
  return { ok: true, claims: verified.claims }
}
