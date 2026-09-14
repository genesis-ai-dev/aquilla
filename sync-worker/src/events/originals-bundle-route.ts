// GET /api/v1/projects/:projectId/export/originals
//
// Zip of every file_source_blobs original in the project (AQU-656). Ignores
// UI filters. Files whose R2 object is missing are skipped; 404 only when
// nothing could be packed.
//
// Auth: same exportMinRole floor as export/bundle (AQU-253).

import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import { ROLE } from "./role-policy"
import { resolveExportFloor } from "./export-floor"
import { humanOriginalDownloadName, uniqueZipEntryName } from "../../../shared/import-contract"
import { makeZip, type ZipEntry } from "../lib/zip"
import { readOriginalSourceBytes } from "./original-source"

export interface OriginalsBundleEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  SNAPSHOTS: R2Bucket
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/export\/originals$/

export async function handleOriginalsBundleRequest(
  request: Request,
  env: OriginalsBundleEnv,
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

  const blobs = await db
    .prepare(
      `SELECT b.file_id AS file_id, b.format AS format, b.raw_source AS raw_source,
              b.r2_key AS r2_key, f.name AS name
         FROM file_source_blobs b
         JOIN files f ON f.id = b.file_id AND f.project_id = b.project_id
        WHERE b.project_id = ?
          AND f.deleted_at IS NULL
        ORDER BY f.name ASC`,
    )
    .bind(projectId)
    .all<{
      file_id: string
      format: string
      raw_source: string | null
      r2_key: string | null
      name: string | null
    }>()
  const rows = blobs.results ?? []
  if (rows.length === 0) {
    return withCors(
      new Response("no original source files in this project", { status: 404 }),
      request,
    )
  }

  const used = new Set<string>()
  const entries: ZipEntry[] = []
  for (const row of rows) {
    const resolved = await readOriginalSourceBytes(row, env.SNAPSHOTS)
    if (!resolved.ok) continue
    const name = uniqueZipEntryName(
      humanOriginalDownloadName(row.name, row.format),
      used,
    )
    entries.push({ name, data: resolved.bytes })
  }
  if (entries.length === 0) {
    return withCors(
      new Response("source bytes missing from storage — re-import", { status: 404 }),
      request,
    )
  }

  const zip = makeZip(entries)
  const project = await db
    .prepare(`SELECT name FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ name: string }>()
  const safe = (project?.name ?? "project").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  const zipName = `${safe || "project"}-originals.zip`

  return withCors(
    new Response(zip, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName.replace(/"/g, "")}"`,
        "X-Content-Type-Options": "nosniff",
      },
    }),
    request,
  )
}
