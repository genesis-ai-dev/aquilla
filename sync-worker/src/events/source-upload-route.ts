// PUT /api/v1/projects/:projectId/files/:fileId/source
//
// Accepts immutable original bytes from the client during import and
// stores them in the SNAPSHOTS R2 bucket. Writes a file_source_blobs pointer
// row so downstream export/diff tooling can retrieve the original without the
// client re-uploading it.
//
// Auth: mirrors import-route.ts — valid aud=sync JWT scoped to (projectId,
// fileId), role >= PROJECT_LEAD (500).  Source writes are importer/lead-only.
//
// Returns null when the path/method doesn't match (router fall-through).

import { withCors } from "../cors"
import { r2KeyPrefix, type AudioEnv } from "../audio"
import { verifyTokenForDoc } from "../auth"
import { ROLE } from "./role-policy"

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source$/

// No documented product limit on original-source size; 50 MB comfortably
// covers real DOCX/PPTX imports while capping unbounded R2 writes / memory use.
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024

export interface SourceUploadEnv extends Pick<AudioEnv, "R2_KEY_PREFIX"> {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

export function sourceObjectKey(
  env: Pick<AudioEnv, "R2_KEY_PREFIX">,
  projectId: string,
  fileId: string,
  format: string,
): string {
  const knownExtensions: Record<string, string> = {
    docx: "docx",
    pptx: "pptx",
    usfm: "usfm",
    usx: "usx",
    md: "md",
    txt: "txt",
    vtt: "vtt",
    srt: "srt",
    xliff: "xlf",
    tmx: "tmx",
    csv: "csv",
    tsv: "tsv",
    "custom-original": "bin",
  }
  const ext = knownExtensions[format] ?? "bin"
  return `${r2KeyPrefix(env)}projects/${projectId}/files/${fileId}/source/original.${ext}`
}

export async function handleSourceUploadRequest(
  request: Request,
  env: SourceUploadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = PATH_RE.exec(url.pathname)
  if (!match) return null
  if (request.method !== "PUT") return null

  if (!env.AQUILLA_PG) {
    return withCors(new Response("AQUILLA_PG binding not configured", { status: 500 }), request)
  }
  const db = env.AQUILLA_PG

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  // Mirror auth from import-route.ts:147-159.
  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  const auth = await verifyTokenForDoc(
    token,
    { projectId, fileId },
    env.SYNC_SECRET_KEY,
  )
  if (!auth.ok) {
    return withCors(new Response(auth.reason, { status: auth.status }), request)
  }
  if (auth.claims.role < ROLE.PROJECT_LEAD) {
    return withCors(
      new Response("role too low for source upload", { status: 403 }),
      request,
    )
  }

  const format = request.headers.get("X-Source-Format")?.trim().toLowerCase() ?? ""
  if (!/^[a-z0-9][a-z0-9+._-]{0,63}$/.test(format)) {
    return withCors(new Response("invalid source format", { status: 400 }), request)
  }

  // Reject oversize uploads before buffering the whole body when the client
  // advertises the size; the post-buffer check below is the backstop.
  const declaredLength = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
    return withCors(new Response("source too large", { status: 413 }), request)
  }

  const body = await request.arrayBuffer()
  if (body.byteLength === 0) {
    return withCors(new Response("empty body", { status: 400 }), request)
  }
  if (body.byteLength > MAX_SOURCE_BYTES) {
    return withCors(new Response("source too large", { status: 413 }), request)
  }

  const key = sourceObjectKey(env, projectId, fileId, format)
  const contentTypes: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    usfm: "text/plain; charset=utf-8",
    usx: "application/xml; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    vtt: "text/vtt; charset=utf-8",
    srt: "application/x-subrip; charset=utf-8",
    xliff: "application/xliff+xml",
    tmx: "application/xml",
    csv: "text/csv; charset=utf-8",
    tsv: "text/tab-separated-values; charset=utf-8",
  }
  const contentType = contentTypes[format] ?? "application/octet-stream"

  await env.SNAPSHOTS.put(key, body, { httpMetadata: { contentType } })

  await db.prepare(
    `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT (file_id) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       format     = EXCLUDED.format,
       raw_source = NULL,
       r2_key     = EXCLUDED.r2_key,
       size_bytes = EXCLUDED.size_bytes,
       created_at = EXCLUDED.created_at`,
  )
    .bind(fileId, projectId, format, key, body.byteLength, Date.now())
    .run()

  return withCors(
    new Response(JSON.stringify({ ok: true, key }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    request,
  )
}
