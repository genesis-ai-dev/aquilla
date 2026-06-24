// PUT /api/v1/projects/:projectId/files/:fileId/source
//
// Accepts the raw .docx (or .pptx) bytes from the client during import and
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

export interface SourceUploadEnv extends Pick<AudioEnv, "R2_KEY_PREFIX"> {
  SNAPSHOTS: R2Bucket
  AQUILLA_PG: AquillaDb
  SYNC_SECRET_KEY?: string
}

export function sourceObjectKey(
  env: Pick<AudioEnv, "R2_KEY_PREFIX">,
  projectId: string,
  fileId: string,
  format: string,
): string {
  const ext = format === "pptx" ? "pptx" : "docx"
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

  const format =
    request.headers.get("X-Source-Format") === "pptx" ? "pptx" : "docx"

  const body = await request.arrayBuffer()
  if (body.byteLength === 0) {
    return withCors(new Response("empty body", { status: 400 }), request)
  }

  const key = sourceObjectKey(env, projectId, fileId, format)
  const contentType =
    format === "pptx"
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

  await env.SNAPSHOTS.put(key, body, { httpMetadata: { contentType } })

  await env.AQUILLA_PG.prepare(
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
