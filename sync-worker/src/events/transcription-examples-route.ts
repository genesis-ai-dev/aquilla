// Zero-shot transcription examples (Omnilingual ASR spec §2).
//
//   GET /api/v1/projects/:projectId/transcription-examples
//        ?lane=<target lane tag>&sourceText=&excludeCellId=&limit=
//   GET /api/v1/transcription-examples/audio?p=&f=&a=&exp=&sig=
//
// The first picks up to 10 (audio, transcript) pairs from this project for the
// Omnilingual zero-shot model: recorded dubs in the lane whose target cell has
// text. The second serves one picked take's bytes to the Modal service.
//
// Why a signed URL and not an R2 presign: this repo holds no R2 S3 API
// credentials. The Modal box cannot present a sync-token, so each example URL
// carries an HMAC (SYNC_SECRET_KEY) over exactly one object and a 10-minute
// expiry — the same idea as diarization's per-job fetch token, minus the row.
// auth-worker only forwards example URLs that point at this route.
//
// Auth (examples): sync-token scoped to projectId, contributor (400) and up —
// examples feed a billed transcription only contributors can start. With the
// AQU-730 read wall on, a lane the caller was not granted returns [].

import { verifyTokenForProject, WRITE_ROLE_LEVEL } from "../auth"
import { audioObjectKey, isPathSafeId, safeAudioContentType } from "../audio"
import { secureCompare } from "../lib/secure-compare"
import { canReadRequestedLane, visibleLanesForRead } from "./lane-read-wall"

export interface TranscriptionExamplesEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  LANE_READ_WALL?: string
  SNAPSHOTS?: R2Bucket
  R2_KEY_PREFIX?: string
  /** Public base of this worker (incl. /sync in prod); shared with diarization. */
  DIARIZATION_PUBLIC_BASE?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/transcription-examples$/
const AUDIO_PATH = "/api/v1/transcription-examples/audio"

export const EXAMPLE_MIN_MS = 2000
export const EXAMPLE_MAX_MS = 30000
export const EXAMPLE_MAX_LIMIT = 10
/** Similarity is scored in the Worker, over this many newest candidates. */
export const EXAMPLE_CANDIDATE_CAP = 500
export const EXAMPLE_URL_TTL_SEC = 600
/** Clips in this window carry enough speech without crowding the 30 s slot. */
const PREFERRED_MIN_MS = 8000
const PREFERRED_MAX_MS = 15000

export interface ExampleCandidate {
  cellId: string
  fileId: string
  audioId: string
  text: string
  sourceText: string
  durationMs: number
  validated: boolean
  createdTs: number
}

/** Lower-cased word set: letters/marks/numbers of any script. */
function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
}

export function jaccard(a: string, b: string): number {
  const left = wordSet(a)
  const right = wordSet(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

/** Distance from the 8–15 s band; 0 inside it. */
function durationPenalty(ms: number): number {
  if (ms < PREFERRED_MIN_MS) return PREFERRED_MIN_MS - ms
  if (ms > PREFERRED_MAX_MS) return ms - PREFERRED_MAX_MS
  return 0
}

/** Validated first, then source-text similarity (when given), then a duration
 *  near 8–15 s, then newest. Pure, so the order is testable without a DB. */
export function rankExamples(
  candidates: readonly ExampleCandidate[],
  sourceText: string | undefined,
  limit: number,
): ExampleCandidate[] {
  const query = sourceText?.trim() ? sourceText : undefined
  const scored = candidates.map(candidate => ({
    candidate,
    similarity: query ? jaccard(query, candidate.sourceText) : 0,
  }))
  scored.sort((a, b) =>
    Number(b.candidate.validated) - Number(a.candidate.validated)
    || b.similarity - a.similarity
    || durationPenalty(a.candidate.durationMs) - durationPenalty(b.candidate.durationMs)
    || b.candidate.createdTs - a.candidate.createdTs)
  return scored.slice(0, limit).map(s => s.candidate)
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("")
}

async function signExample(secret: string, p: string, f: string, a: string, exp: number) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  // Domain-separated so this MAC can never stand in for any other token.
  const message = `omni-example-audio\n${p}\n${f}\n${a}\n${exp}`
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)))
}

export async function signedExampleAudioUrl(
  base: string, secret: string, p: string, f: string, a: string, exp: number,
): Promise<string> {
  const url = new URL(`${base.replace(/\/+$/, "")}${AUDIO_PATH}`)
  url.searchParams.set("p", p)
  url.searchParams.set("f", f)
  url.searchParams.set("a", a)
  url.searchParams.set("exp", String(exp))
  url.searchParams.set("sig", await signExample(secret, p, f, a, exp))
  return url.toString()
}

interface CandidateRow {
  cell_id: string
  file_id: string
  audio_id: string
  text: string
  source_text: string | null
  effective_ms: number | string
  validated: boolean | number
  created_ts: number | string
}

export async function handleTranscriptionExamplesRequest(
  request: Request,
  env: TranscriptionExamplesEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname === AUDIO_PATH && request.method === "GET") return serveExampleAudio(url, env)
  const match = url.pathname.match(PATH_RE)
  if (!match || request.method !== "GET") return null
  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if (!env.AQUILLA_PG) return new Response("AQUILLA_PG binding not configured", { status: 500 })

  const projectId = decodeURIComponent(match[1])
  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return new Response("missing Authorization header", { status: 401 })
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })
  if (auth.claims.role < WRITE_ROLE_LEVEL) return new Response("contributor role required", { status: 403 })

  // `lane` is required and read with `has`: `?lane=` is the former default
  // target lane (legacy_tag ''), as in cell-audio-read-route.ts.
  if (!url.searchParams.has("lane")) return new Response("lane is required", { status: 400 })
  const lane = url.searchParams.get("lane") ?? ""
  const sourceText = url.searchParams.get("sourceText")?.slice(0, 4000) ?? undefined
  const excludeCellId = url.searchParams.get("excludeCellId") ?? ""
  const rawLimit = Number(url.searchParams.get("limit") ?? EXAMPLE_MAX_LIMIT)
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1
    ? Math.min(rawLimit, EXAMPLE_MAX_LIMIT) : EXAMPLE_MAX_LIMIT
  const noStore = { headers: { "Cache-Control": "private, no-store" } }

  const visible = visibleLanesForRead(env.LANE_READ_WALL, auth.claims)
  if (!(await canReadRequestedLane(env.AQUILLA_PG, projectId, visible, lane))) {
    return Response.json([], noStore)
  }
  const laneRow = await env.AQUILLA_PG.prepare(
    `SELECT id FROM lanes WHERE project_id = ? AND role = 'target' AND legacy_tag = ? LIMIT 1`,
  ).bind(projectId, lane).first<{ id: string }>()
  if (!laneRow) return Response.json([], noStore)

  // Human recordings only (role 'dub', slot 'recording' — not programme audio
  // or generated voices), the selected take, live, and a target cell with
  // text to learn from. Effective duration honours the take's kept window
  // (trim_end_ms is an end POSITION; see src/lib/audio/kept-window.ts).
  const res = await env.AQUILLA_PG.prepare(
    `SELECT * FROM (
       SELECT DISTINCT ON (a.file_id, a.cell_id)
              a.cell_id, a.file_id, a.audio_id, c.value AS text, s.value AS source_text,
              (CASE WHEN a.trim_end_ms IS NOT NULL AND a.trim_end_ms > COALESCE(a.trim_start_ms, 0)
                    THEN a.trim_end_ms ELSE a.duration_ms END)
                - COALESCE(a.trim_start_ms, 0) AS effective_ms,
              (a.validator_count > 0 OR c.validated <> 0) AS validated,
              a.created_ts
         FROM cell_audio a
         JOIN cells c ON c.project_id = a.project_id AND c.file_id = a.file_id
                     AND c.cell_id = a.cell_id AND c.side = 'target' AND c.lane_id = ?
         LEFT JOIN cells s ON s.project_id = a.project_id AND s.file_id = a.file_id
                          AND s.cell_id = a.cell_id AND s.side = 'source'
        WHERE a.project_id = ? AND a.deleted = 0 AND a.selected = 1
          AND a.role = 'dub' AND a.slot = 'recording' AND a.duration_ms IS NOT NULL
          AND (a.lane_id = ? OR (a.lane_id IS NULL AND ? = ''))
          AND btrim(c.value) <> '' AND a.cell_id <> ?
          AND (s.hidden_at IS NULL)
        ORDER BY a.file_id, a.cell_id, a.created_ts DESC
     ) picked
     WHERE effective_ms >= ? AND effective_ms <= ?
     ORDER BY created_ts DESC
     LIMIT ?`,
  ).bind(
    laneRow.id, projectId, laneRow.id, lane, excludeCellId,
    EXAMPLE_MIN_MS, EXAMPLE_MAX_MS, EXAMPLE_CANDIDATE_CAP,
  ).all<CandidateRow>()

  const candidates: ExampleCandidate[] = (res.results ?? []).map(row => ({
    cellId: row.cell_id,
    fileId: row.file_id,
    audioId: row.audio_id,
    text: row.text,
    sourceText: row.source_text ?? "",
    durationMs: Number(row.effective_ms),
    validated: Boolean(row.validated),
    createdTs: Number(row.created_ts),
  }))
  // Belt and braces: the SQL bounds already apply, but the 2–30 s rule is the
  // contract the model depends on, so it holds even if the query changes.
    .filter(c => c.durationMs >= EXAMPLE_MIN_MS && c.durationMs <= EXAMPLE_MAX_MS)
    .filter(c => isPathSafeId(c.fileId) && isPathSafeId(c.audioId))

  const base = env.DIARIZATION_PUBLIC_BASE?.trim() || url.origin
  const exp = Math.floor(Date.now() / 1000) + EXAMPLE_URL_TTL_SEC
  const picked = rankExamples(candidates, sourceText, limit)
  const body = await Promise.all(picked.map(async c => ({
    cellId: c.cellId,
    fileId: c.fileId,
    text: c.text,
    durationMs: c.durationMs,
    audioUrl: await signedExampleAudioUrl(base, env.SYNC_SECRET_KEY!, projectId, c.fileId, c.audioId, exp),
  })))
  return Response.json(body, noStore)
}

async function serveExampleAudio(url: URL, env: TranscriptionExamplesEnv): Promise<Response> {
  if (!env.SYNC_SECRET_KEY || !env.SNAPSHOTS) return new Response("not configured", { status: 500 })
  const p = url.searchParams.get("p") ?? ""
  const f = url.searchParams.get("f") ?? ""
  const a = url.searchParams.get("a") ?? ""
  const exp = Number(url.searchParams.get("exp") ?? "")
  const sig = url.searchParams.get("sig") ?? ""
  if (![p, f, a].every(isPathSafeId) || !Number.isInteger(exp) || !sig) {
    return new Response("not found", { status: 404 })
  }
  const expected = await signExample(env.SYNC_SECRET_KEY, p, f, a, exp)
  // Same answer for a bad signature and an expired one: don't leak which.
  if (!secureCompare(expected, sig) || exp < Math.floor(Date.now() / 1000)) {
    return new Response("not found", { status: 404 })
  }
  const obj = await env.SNAPSHOTS.get(audioObjectKey(env, p, f, a))
  if (!obj) return new Response("not found", { status: 404 })
  return new Response(obj.body, {
    headers: {
      "Content-Type": safeAudioContentType(obj.httpMetadata?.contentType),
      "Content-Length": String(obj.size),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  })
}
