// GET /api/v1/projects/:projectId/export/bundle
//
// Manager "download the deliverable": zips every USFM source file in the
// project, each round-tripped through the lossless serializer with the current
// target translations overlaid (same per-file logic as handleExportSourceRequest,
// applied across all files and packaged into one .zip).
//
// Auth: sync-token JWT scoped to projectId; role floor = org's exportMinRole
// setting (default MAINTAINER / 600 per spec Q32 — see AQU-253). Org owners
// can raise or lower the floor via org settings.
//
// Returns null if the URL doesn't match (chainable in the fetch dispatcher).
// PURE-ADDITIVE: a new file that reuses usfm-lossless + a dependency-free zip
// writer; it does not touch the import / event-projection path.

import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import { ROLE } from "./role-policy"
import { resolveExportFloor } from "./export-floor"
import { parseUsfmLossless, serializeUsfmLossless } from "../lib/usfm-lossless"
import { makeZip, type ZipEntry } from "../lib/zip"

export interface ExportBundleEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/export\/bundle$/

function sfmName(name: string, fileId: string): string {
  const base = name || `${fileId}.sfm`
  return /\.(sfm|usfm)$/i.test(base) ? base : `${base}.SFM`
}

export async function handleExportBundleRequest(
  request: Request,
  env: ExportBundleEnv,
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
  // AQU-253: org-level export floor (defaults to MAINTAINER if unset).
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
      `SELECT file_id, raw_source FROM file_source_blobs
        WHERE project_id = ? AND format = 'usfm'`,
    )
    .bind(projectId)
    .all<{ file_id: string; raw_source: string }>()
  const rows = blobs.results ?? []
  if (rows.length === 0) {
    return withCors(
      new Response("no exportable source files in this project", { status: 404 }),
      request,
    )
  }

  const enc = new TextEncoder()
  const entries: ZipEntry[] = []
  for (const { file_id, raw_source } of rows) {
    const meta = await db
      .prepare(`SELECT name FROM files WHERE id = ? AND project_id = ?`)
      .bind(file_id, projectId)
      .first<{ name: string }>()

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
      .bind(projectId, file_id)
      .all<{ canonical_ref: string; value: string }>()

    const overrides = new Map<string, string>()
    for (const row of cells.results ?? []) overrides.set(row.canonical_ref, row.value)

    const out = serializeUsfmLossless(parseUsfmLossless(raw_source), overrides)
    entries.push({ name: sfmName(meta?.name ?? "", file_id), data: enc.encode(out) })
  }

  const zip = makeZip(entries)
  return withCors(
    new Response(zip, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${projectId}-deliverable.zip"`,
      },
    }),
    request,
  )
}

// resolveExportFloor is now in ./export-floor.ts (shared with export-route.ts).
// Imported above — see AQU-253 note in that module for behavior and caveats.
