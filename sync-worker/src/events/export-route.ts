// GET /api/v1/projects/:projectId/files/:fileId/source
//
// Reconstructs the source file (currently USFM only) by:
//   1. Reading the imported raw bytes from `file_source_blobs`
//   2. Reading the file's target-side cells (current translations)
//   3. Running the lossless serializer to substitute each verse's text
//
// Returns text/plain with a content-disposition that suggests the original
// file name. The translator's in-progress state is what gets exported —
// empty cells fall back to the source verse so the file stays valid USFM.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) is enough — anyone
// who can read the project can download an export of it.
//
// Returns null if the URL doesn't match (chainable in the fetch dispatcher).

import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import {
  parseUsfmLossless,
  serializeUsfmLossless,
} from "../lib/usfm-lossless"

export interface ExportRouteEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source$/

export async function handleExportSourceRequest(
  request: Request,
  env: ExportRouteEnv,
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
  if (!env.AQUILLA_DB) {
    return withCors(new Response("AQUILLA_DB binding not configured", { status: 500 }), request)
  }
  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const db = env.AQUILLA_DB

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return withCors(new Response(auth.reason, { status: auth.status }), request)
  }

  const blob = await db
    .prepare(
      `SELECT format, raw_source FROM file_source_blobs
        WHERE file_id = ? AND project_id = ?`,
    )
    .bind(fileId, projectId)
    .first<{ format: string; raw_source: string }>()
  if (!blob) {
    return withCors(
      new Response(
        "no source blob recorded for this file — re-import to enable export",
        { status: 404 },
      ),
      request,
    )
  }

  // File name for the download
  const fileMeta = await db
    .prepare(`SELECT name FROM files WHERE id = ? AND project_id = ?`)
    .bind(fileId, projectId)
    .first<{ name: string }>()
  const fileName = fileMeta?.name || `${fileId}.sfm`

  if (blob.format !== "usfm") {
    return withCors(
      new Response(`export not yet supported for format "${blob.format}"`, { status: 501 }),
      request,
    )
  }

  // Pull every target cell paired with a source cell that has a canonical_ref
  // (the verse address). The projection writes canonical_ref ONLY on the
  // source side; the target side is paired by (project_id, file_id, cell_id)
  // and inherits its addressability from the source twin.
  const cells = await db
    .prepare(
      `SELECT s.canonical_ref AS canonical_ref, t.value AS value
         FROM cells t
         JOIN cells s
           ON s.project_id = t.project_id
          AND s.file_id    = t.file_id
          AND s.cell_id    = t.cell_id
          AND s.side       = 'source'
        WHERE t.project_id = ?
          AND t.file_id    = ?
          AND t.side       = 'target'
          AND s.canonical_ref IS NOT NULL
          AND t.value <> ''`,
    )
    .bind(projectId, fileId)
    .all<{ canonical_ref: string; value: string }>()

  const overrides = new Map<string, string>()
  for (const row of cells.results ?? []) {
    overrides.set(row.canonical_ref, row.value)
  }

  const doc = parseUsfmLossless(blob.raw_source)
  const out = serializeUsfmLossless(doc, overrides)

  const downloadName = fileName.toLowerCase().endsWith(".sfm")
    ? fileName
    : fileName.toLowerCase().endsWith(".usfm")
      ? fileName
      : `${fileName}.SFM`

  return withCors(
    new Response(out, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${downloadName.replace(/"/g, "")}"`,
      },
    }),
    request,
  )
}
