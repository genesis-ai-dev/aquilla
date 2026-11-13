// GET /api/v1/projects/:projectId/export/bundle
//
// Manager "download the deliverable": zips every USFM source file in the
// project, each round-tripped through the lossless serializer with the current
// target translations overlaid (same per-file logic as handleExportSourceRequest,
// applied across all files and packaged into one .zip).
//
// AQU-991: a file with NO source blob at all still belongs in the deliverable.
// Codex-migrated projects arrive through /migrate/ingest, which writes events
// and the projection but never a `file_source_blobs` row, so there is no
// original document to round-trip. Those projects used to 404 the whole
// deliverable with "no exportable source files in this project" — the "get your
// data out" promise failing on exactly the projects that were migrated for us.
// Such files now export as the server-built translated plain text
// (`buildPlainTextExport`, the same output as the in-app `.txt` export), named
// `<file>.txt` so the recipient can see which fidelity they got. A file that
// HAS an original in another format (docx/pptx/idml/txt) is deliberately left
// out: its deliverable is a patched copy of that package, which only the client
// can build, and it is already reachable through per-file export and
// "Download all originals".
//
// Auth: sync-token JWT scoped to projectId; role floor = org's exportMinRole
// setting (default MAINTAINER / 600 per spec Q32 — see AQU-253). Org owners
// can raise or lower the floor via org settings.
//
// Returns null if the URL doesn't match (chainable in the fetch dispatcher).
// PURE-ADDITIVE: a new file that reuses usfm-lossless + a dependency-free zip
// writer; it does not touch the import / event-projection path.

import { attachmentDisposition } from "./content-disposition"
import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import { ROLE } from "./role-policy"
import { resolveExportFloor } from "./export-floor"
import { parseUsfmLossless } from "../lib/usfm-lossless"
import { serializeUsfmWithLayout } from "../../../db/shared/usfm-layout"
import { buildUsfmExportPlan } from "./usfm-export-plan"
import { buildPlainTextExport } from "./plaintext-export"
import { makeZip, type ZipEntry } from "../lib/zip"
import { countedFileSql } from "../../../db/shared/counted-files"
import { uniqueZipEntryName } from "../../../shared/import-contract"

export interface ExportBundleEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  SNAPSHOTS: R2Bucket
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/export\/bundle$/

function sfmName(name: string, fileId: string): string {
  const base = name || `${fileId}.sfm`
  return /\.(sfm|usfm)$/i.test(base) ? base : `${base}.SFM`
}

/** AQU-991: entry name for a file exported as translated plain text. */
function txtName(name: string, fileId: string): string {
  const base = name || fileId
  return /\.txt$/i.test(base) ? base : `${base}.txt`
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
  const lane = url.searchParams.get("lane") ?? ""
  // AQU-1148: same contract as the single-file route — ?validated=1 overlays
  // only translations meeting the project's validation threshold.
  const validatedOnly = url.searchParams.get("validated") === "1"
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
      `SELECT file_id, raw_source, r2_key FROM file_source_blobs
        WHERE project_id = ? AND format = 'usfm'`,
    )
    .bind(projectId)
    .all<{ file_id: string; raw_source: string | null; r2_key: string | null }>()
  const rows = blobs.results ?? []

  // AQU-991: which files have an original of ANY format? Those without one
  // fall back to translated plain text below. Kept as its own id-only query so
  // a legacy inline base64 side-car is never pulled into memory just to learn
  // that it exists.
  const anyBlob = await db
    .prepare(`SELECT file_id FROM file_source_blobs WHERE project_id = ?`)
    .bind(projectId)
    .all<{ file_id: string }>()
  const withOriginal = new Set((anyBlob.results ?? []).map((r) => r.file_id))
  const countedFiles = await db
    .prepare(
      `SELECT f.id AS file_id, f.name AS name
         FROM files f
        WHERE f.project_id = ? AND ${countedFileSql("f")}
        ORDER BY f.name ASC`,
    )
    .bind(projectId)
    .all<{ file_id: string; name: string | null }>()
  const plainTextCandidates = (countedFiles.results ?? [])
    .filter((f) => !withOriginal.has(f.file_id))

  const enc = new TextEncoder()
  const entries: ZipEntry[] = []
  const usedNames = new Set<string>()
  for (const { file_id, raw_source, r2_key } of rows) {
    const meta = await db
      .prepare(`SELECT name FROM files WHERE id = ? AND project_id = ?`)
      .bind(file_id, projectId)
      .first<{ name: string }>()

    // Translations, plus the file's structural edits — content added under a
    // verse and verses removed outright. AQU-1068 moved this into a shared
    // builder: the query above used to be a character-for-character copy of
    // export-route.ts's, with nothing enforcing that they stayed identical.
    const { overrides, edits } = await buildUsfmExportPlan(db, projectId, file_id, lane, { validatedOnly })

    let original = raw_source
    if (!original && r2_key) {
      const object = await env.SNAPSHOTS.get(r2_key)
      if (!object) {
        return withCors(
          new Response(`source bytes missing from storage for file ${file_id} — re-import`, { status: 404 }),
          request,
        )
      }
      original = new TextDecoder().decode(await object.arrayBuffer())
    }
    if (!original) {
      return withCors(
        new Response(`no source text recorded for file ${file_id} — re-import`, { status: 404 }),
        request,
      )
    }

    const out = serializeUsfmWithLayout(parseUsfmLossless(original), overrides, edits)
    entries.push({
      name: uniqueZipEntryName(sfmName(meta?.name ?? "", file_id), usedNames),
      data: enc.encode(out),
    })
  }

  // AQU-991: translated plain text for every file with no original to
  // round-trip. A file with nothing to say — no cells, or none validated under
  // ?validated=1 — is skipped rather than shipped as an empty entry.
  for (const { file_id, name } of plainTextCandidates) {
    // AQU-2383: the builder also reports whether the rebuild is untouched, so
    // the per-file route can serve the stored upload instead. These files have
    // no stored upload by definition, so only the rebuilt body applies here.
    const { body } = await buildPlainTextExport(db, projectId, file_id, lane, { validatedOnly })
    if (!body.trim()) continue
    entries.push({
      name: uniqueZipEntryName(txtName(name ?? "", file_id), usedNames),
      data: enc.encode(body),
    })
  }

  // AQU-991: the only remaining reason to refuse. Says which of the two is
  // missing — the old "no exportable source files in this project" asserted the
  // project had no source files, which was the wrong diagnosis for a migrated
  // project that has plenty of content and simply never had an original.
  if (entries.length === 0) {
    return withCors(
      new Response(
        "nothing to export in this project — no file has a source document to"
        + " round-trip, and none has text to export",
        { status: 404 },
      ),
      request,
    )
  }

  const zip = makeZip(entries)
  return withCors(
    new Response(zip, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentDisposition(`${projectId}-deliverable.zip`),
      },
    }),
    request,
  )
}

// resolveExportFloor is now in ./export-floor.ts (shared with export-route.ts).
// Imported above — see AQU-253 note in that module for behavior and caveats.
