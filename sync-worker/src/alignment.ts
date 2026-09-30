import { verifyTokenForDoc, WRITE_ROLE_LEVEL } from "./auth"
import { audioObjectKey, isPathSafeId, safeAudioContentType } from "./audio"
import { secureCompare } from "./lib/secure-compare"
import { ALIGNMENT_JOB_TIMEOUT_MS, isAcousticAlignmentResult } from "../../shared/script-alignment"

export interface AlignmentEnv {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  ALIGNMENT_MODAL_URL?: string
  ALIGNMENT_SHARED_SECRET?: string
  ALIGNMENT_PUBLIC_BASE?: string
}

interface Job {
  id: string
  project_id: string
  file_id: string
  audio_object: string
  fetch_token: string
  status: string
  script: string
  language: string
  result_json: string | null
  error: string | null
  created_at: number
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const getJob = (env: AlignmentEnv, id: string) => env.AQUILLA_PG!
  .prepare("SELECT * FROM alignment_jobs WHERE id = ?").bind(id).first<Job>()

async function expireJob(env: AlignmentEnv, job: Job): Promise<Job> {
  const now = Date.now()
  if (!["queued", "running"].includes(job.status)
      || now - Number(job.created_at) < ALIGNMENT_JOB_TIMEOUT_MS) return job
  await env.AQUILLA_PG!.prepare(`UPDATE alignment_jobs SET status = 'failed',
    error = ?, fetch_token = '', updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running') AND created_at <= ?`)
    .bind("Acoustic alignment timed out.", now, job.id,
      now - ALIGNMENT_JOB_TIMEOUT_MS).run()
  return (await getJob(env, job.id))!
}

async function readJobBody(request: Request, limit: number): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error("Missing request body")
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
  let bytes = 0
  let text = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new Error("Request body exceeds limit")
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object")
    }
    return parsed as Record<string, unknown>
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

async function authorize(request: Request, env: AlignmentEnv,
  projectId: string, fileId: string, write = false): Promise<Response | null> {
  const header = request.headers.get("Authorization") ?? ""
  const verified = await verifyTokenForDoc(
    header.startsWith("Bearer ") ? header.slice(7) : null,
    { projectId, fileId }, env.SYNC_SECRET_KEY,
  )
  if (!verified.ok) return json({ error: verified.reason }, verified.status)
  if (write && verified.claims.role < WRITE_ROLE_LEVEL) {
    return json({ error: "insufficient role" }, 403)
  }
  return null
}

export async function handleAlignmentRequest(request: Request,
  env: AlignmentEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const prefix = "/api/v1/alignment/"
  if (!url.pathname.startsWith(prefix)) return null
  if (!env.AQUILLA_PG) return json({ error: "alignment not configured" }, 503)
  const route = url.pathname.slice(prefix.length)
  if (route === "start" && request.method === "POST") return start(request, env)
  if (route === "callback" && request.method === "POST") return callback(request, env)
  if (request.method !== "GET" || !["status", "audio"].includes(route)) {
    return json({ error: "not found" }, 404)
  }
  let job = await getJob(env, url.searchParams.get("jobId") ?? "")
  if (!job) return json({ error: "job not found" }, 404)
  if (route === "audio") {
    if (!["queued", "running"].includes(job.status) || !secureCompare(
      url.searchParams.get("t") ?? "", job.fetch_token,
    )) return json({ error: "not found" }, 404)
    job = await expireJob(env, job)
    if (!["queued", "running"].includes(job.status)) {
      return json({ error: "not found" }, 404)
    }
    const object = await env.SNAPSHOTS.get(audioObjectKey(
      env, job.project_id, job.file_id, job.audio_object,
    ))
    if (!object) return json({ error: "audio not found" }, 404)
    return new Response(object.body, { headers: {
      "Content-Type": safeAudioContentType(object.httpMetadata?.contentType),
      "Content-Length": String(object.size), "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    } })
  }
  const denied = await authorize(request, env, job.project_id, job.file_id)
  if (denied) return denied
  job = await expireJob(env, job)
  return json({ jobId: job.id, status: job.status,
    ...(job.result_json ? { result: JSON.parse(job.result_json) } : {}),
    ...(job.error ? { error: job.error } : {}),
  })
}

async function start(request: Request, env: AlignmentEnv): Promise<Response> {
  if (!env.ALIGNMENT_MODAL_URL || !env.ALIGNMENT_SHARED_SECRET ||
      !env.ALIGNMENT_PUBLIC_BASE) return json({ error: "alignment not configured" }, 503)
  let body: Record<string, unknown>
  try { body = await readJobBody(request, 1024 * 1024) }
  catch { return json({ error: "invalid or oversized JSON" }, 400) }
  const { projectId, fileId, audioObject, script, language } = body
  if (typeof projectId !== "string" || typeof fileId !== "string" ||
      typeof audioObject !== "string" || !isPathSafeId(projectId) ||
      !isPathSafeId(fileId) || !isPathSafeId(audioObject) ||
      typeof script !== "string" || !script.trim() || script.length > 200_000 ||
      typeof language !== "string" || !/^[a-z]{2,3}$/.test(language)) {
    return json({ error: "invalid source audio, script, or language" }, 400)
  }
  const denied = await authorize(request, env, projectId, fileId, true)
  if (denied) return denied
  const jobId = crypto.randomUUID()
  const fetchToken = crypto.randomUUID() + crypto.randomUUID()
  const now = Date.now()
  await env.AQUILLA_PG!.prepare(`INSERT INTO alignment_jobs
    (id, project_id, file_id, audio_object, fetch_token, status,
     script, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
    .bind(jobId, projectId, fileId, audioObject, fetchToken, script, language, now, now).run()
  const base = env.ALIGNMENT_PUBLIC_BASE.replace(/\/+$/, "")
  try {
    const response = await fetch(env.ALIGNMENT_MODAL_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.ALIGNMENT_SHARED_SECRET, jobId,
        script, language,
        audioUrl: `${base}/api/v1/alignment/audio?jobId=${jobId}&t=${fetchToken}`,
        callbackUrl: `${base}/api/v1/alignment/callback`,
      }), signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error("alignment service rejected start")
    await env.AQUILLA_PG!.prepare(`UPDATE alignment_jobs SET status = 'running',
      updated_at = ? WHERE id = ? AND status = 'queued'`).bind(Date.now(), jobId).run()
  } catch {
    await env.AQUILLA_PG!.prepare(`UPDATE alignment_jobs SET status = 'failed',
      error = ?, fetch_token = '', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')`)
      .bind("Alignment service could not start the job.", Date.now(), jobId).run()
    return json({ error: "alignment service unavailable" }, 502)
  }
  const job = await getJob(env, jobId)
  return json({ jobId, status: job!.status })
}

async function callback(request: Request, env: AlignmentEnv): Promise<Response> {
  if (!env.ALIGNMENT_SHARED_SECRET || !secureCompare(
    request.headers.get("X-Alignment-Secret") ?? "", env.ALIGNMENT_SHARED_SECRET,
  )) return json({ error: "unauthorized" }, 401)
  let body: Record<string, unknown>
  try { body = await readJobBody(request, 16 * 1024 * 1024) }
  catch { return json({ error: "invalid or oversized JSON" }, 400) }
  if (typeof body.jobId !== "string" || !["done", "failed"].includes(String(body.status))) {
    return json({ error: "invalid callback" }, 400)
  }
  const job = await getJob(env, body.jobId)
  if (!job) return json({ error: "job not found" }, 404)
  if (body.status === "done" && !isAcousticAlignmentResult(body.result, job.script)) {
    return json({ error: "invalid alignment result" }, 400)
  }
  await expireJob(env, job)
  await env.AQUILLA_PG!.prepare(`UPDATE alignment_jobs SET status = ?,
    result_json = ?, error = ?, fetch_token = '', updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')`)
    .bind(body.status, body.status === "done" ? JSON.stringify(body.result) : null,
      body.status === "failed" ? "Acoustic alignment failed. Review the source language and audio." : null,
      Date.now(), body.jobId).run()
  return json({ ok: true })
}
