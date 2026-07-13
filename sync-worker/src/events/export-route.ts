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
// Auth: sync-token JWT scoped to projectId; role floor = max(MAINTAINER, org
// exportMinRole setting). Default org floor = MAINTAINER (600) per spec Q32.
// Org owners can RAISE the floor (e.g., OWNER only) or LOWER it (e.g.,
// CONTRIBUTOR) via org settings — see AQU-253. Current behavior (maintainer)
// is preserved when no exportMinRole is set.
//
// Returns null if the URL doesn't match (chainable in the fetch dispatcher).

import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import { ROLE } from "./role-policy"
import { resolveExportFloor } from "./export-floor"
import {
  parseUsfmLossless,
  serializeUsfmLossless,
  countLossyVerses,
} from "../lib/usfm-lossless"

export interface ExportRouteEnv {
  AQUILLA_PG?: AquillaDb
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
  // AQU-253: resolve the org-level export floor. Default = MAINTAINER (600).
  // The org may raise it (e.g., OWNER) or lower it (e.g., CONTRIBUTOR).
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

  if (blob.format === "docx" || blob.format === "pptx") {
    // AQU-233: For binary Office formats (DOCX/PPTX) the server serves the
    // raw side-car bytes as-is (base64-decoded back to binary). The client is
    // responsible for XML-injection of translations using JSZip + DOMParser —
    // the worker lacks a ZIP reader library and adding jszip would be a new
    // heavy dependency (flagged per HARD LIMITS). The raw bytes are sufficient
    // for a client-side "open in Word with structure intact" export.
    //
    // SWARM-TODO(AQU-233-server-inject): if a future wave adds jszip to the
    // sync-worker (or implements a DecompressionStream-based ZIP reader), the
    // client-side injection path can be replaced by a lossless server-side
    // serializer that mirrors serializeUsfmLossless.
    const mimeType = blob.format === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    const ext = blob.format === "docx" ? ".docx" : ".pptx"
    const downloadName = fileName.endsWith(ext) ? fileName : `${fileName}${ext}`

    // Decode base64 side-car back to binary.
    let binary: Uint8Array
    try {
      const cleaned = blob.raw_source.replace(/\s/g, "")
      const b64 = atob(cleaned)
      binary = new Uint8Array(b64.length)
      for (let i = 0; i < b64.length; i++) binary[i] = b64.charCodeAt(i)
    } catch {
      return withCors(
        new Response("side-car bytes corrupted — re-import to restore", { status: 500 }),
        request,
      )
    }

    return withCors(
      new Response(binary, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Content-Disposition": `attachment; filename="${downloadName.replace(/"/g, "")}"`,
          // Signal to client: this is a raw side-car, not injection-substituted.
          // The client should perform its own XML injection using the cells it holds.
          "X-Export-Mode": "raw-sidecar",
        },
      }),
      request,
    )
  }

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
  const lossyVerseCount = countLossyVerses(doc, overrides)
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
        // AQU-276: number of translated verses whose original span contained
        // intra-verse markers (footnotes, poetry, character markers) that the
        // plain-text substitution dropped. 0 = clean round-trip. The client
        // reads this to surface a per-export warning in ExportDialog.
        "X-Usfm-Lossy-Verse-Count": String(lossyVerseCount),
      },
    }),
    request,
  )
}

// resolveExportFloor is now in ./export-floor.ts (shared with export-bundle-route.ts).
// Imported above — see AQU-253 note in that module for behavior and caveats.
