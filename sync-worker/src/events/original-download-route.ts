// GET /api/v1/projects/:projectId/files/:fileId/original
//
// Returns the exact imported source blob (R2 or legacy raw_source). Does not
// inject translations — that is GET …/source (AQU-656).
//
// Auth: sync-token JWT scoped to projectId; role floor = org exportMinRole
// (same as export-route / AQU-253). Bearer only — same as Export.

import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import { ROLE } from "./role-policy"
import { resolveExportFloor } from "./export-floor"
import { humanOriginalDownloadName } from "../../../shared/import-contract"
import { readOriginalSourceBytes } from "./original-source"

export interface OriginalDownloadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  SNAPSHOTS: R2Bucket
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/original$/

function attachmentDisposition(fileName: string): string {
  const safe = fileName.replace(/[\r\n"]/g, "_").slice(0, 180)
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

export async function handleOriginalDownloadRequest(
  request: Request,
  env: OriginalDownloadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = PATH_RE.exec(url.pathname)
  if (!match) return null
  if (request.method !== "GET") {
    return withCors(new Response("method not allowed", { status: 405 }), request)
  }
  if (!env.SYNC_SECRET_KEY) {
    return withCors(new Response("SYNC_SECRET_KEY not configured", { status: 500 }), request)
  }
  if (!env.AQUILLA_PG) {
    return withCors(new Response("AQUILLA_PG binding not configured", { status: 500 }), request)
  }
  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const db = env.AQUILLA_PG

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return withCors(new Response(auth.reason, { status: auth.status }), request)
  }
  const exportFloor = await resolveExportFloor(db, projectId)
  if (auth.claims.role < exportFloor) {
    const floorName = exportFloor === ROLE.MAINTAINER ? "maintainer" : `role level ${exportFloor}`
    return withCors(
      new Response(`${floorName} role required to export`, { status: 403 }),
      request,
    )
  }

  const blob = await db
    .prepare(
      `SELECT format, raw_source, r2_key FROM file_source_blobs
        WHERE file_id = ? AND project_id = ?`,
    )
    .bind(fileId, projectId)
    .first<{ format: string; raw_source: string | null; r2_key: string | null }>()
  if (!blob) {
    return withCors(
      new Response(
        "no source blob recorded for this file — re-import to enable download",
        { status: 404 },
      ),
      request,
    )
  }

  const fileMeta = await db
    .prepare(`SELECT name FROM files WHERE id = ? AND project_id = ?`)
    .bind(fileId, projectId)
    .first<{ name: string }>()
  const downloadName = humanOriginalDownloadName(fileMeta?.name, blob.format)
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": attachmentDisposition(downloadName),
    "X-Content-Type-Options": "nosniff",
    "X-Export-Mode": "raw-original",
    "Cache-Control": "no-store",
  }

  const resolved = await readOriginalSourceBytes(blob, env.SNAPSHOTS)
  if (!resolved.ok) {
    return withCors(new Response(resolved.message, { status: resolved.status }), request)
  }

  return withCors(
    new Response(resolved.bytes, { status: 200, headers }),
    request,
  )
}
