// GET /api/v1/projects/:projectId/export/originals
//
// Zip of every file_source_blobs original in the project (AQU-656). Ignores
// UI filters. Files whose R2 object is missing are skipped; 404 only when
// nothing could be packed.
//
// AQU-1863: the archive is streamed. Originals run up to ~95 MB each, so
// reading them all and then copying them into one zip buffer blew the Worker's
// 128 MB memory limit at about two 50 MB files. Existence is settled up front
// with R2 `head()` (metadata only) so the skip/404 contract above is unchanged,
// then each original's bytes are piped straight into the response.
//
// Auth: same exportMinRole floor as export/bundle (AQU-253).

import { attachmentDisposition } from "./content-disposition"
import { verifyTokenForProject } from "../auth"
import { withCors } from "../cors"
import { ROLE } from "./role-policy"
import { resolveExportFloor } from "./export-floor"
import { humanOriginalDownloadName, uniqueZipEntryName } from "../../../shared/import-contract"
import { makeZipStream, type StreamZipEntry } from "../lib/zip"
import {
  decodeInlineOriginal,
  isBase64InlineFormat,
  openOriginalSourceStream,
} from "./original-source"
import { countedFileSql } from "../../../db/shared/counted-files"

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
      // raw_source is deliberately NOT selected: a legacy inline blob is read
      // one at a time while its zip entry is written (AQU-1863), so the result
      // set stays metadata-sized however many originals the project has.
      `SELECT b.file_id AS file_id, b.format AS format,
              length(b.raw_source) AS raw_source_len,
              b.r2_key AS r2_key, f.name AS name
         FROM file_source_blobs b
         JOIN files f ON f.id = b.file_id AND f.project_id = b.project_id
        WHERE b.project_id = ?
          -- AQU-1566: a caption track keeps its original caption file too,
          -- but the track is not a file of the project, so its original is
          -- not one of the project's originals.
          AND ${countedFileSql("f")}
        ORDER BY f.name ASC`,
    )
    .bind(projectId)
    .all<{
      file_id: string
      format: string
      raw_source_len: number | string | null
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

  const readInlineSource = (fileId: string) =>
    db
      .prepare(`SELECT raw_source FROM file_source_blobs WHERE file_id = ? AND project_id = ?`)
      .bind(fileId, projectId)
      .first<{ raw_source: string | null }>()
      .then((r) => r?.raw_source ?? null)

  // Settle which originals are packable BEFORE the response starts, so the
  // "skip what is missing, 404 only when nothing could be packed" contract is
  // the same as when the whole archive was built in memory.
  const used = new Set<string>()
  const entries: StreamZipEntry[] = []
  for (const row of rows) {
    const { file_id: fileId, format, r2_key: r2Key } = row
    let inlineBytes: Uint8Array | null = null
    if (r2Key) {
      // Metadata-only existence check — the bytes are fetched later, while
      // this entry is being written.
      if (!(await env.SNAPSHOTS.head(r2Key))) continue
    } else if (Number(row.raw_source_len ?? 0) <= 0) {
      continue
    } else if (isBase64InlineFormat(format)) {
      // A base64 side-car is the one source that can be *corrupt* rather than
      // just absent, and that is only knowable by decoding it. These are
      // pre-R2 legacy rows, capped by the old D1 row limit, so decoding them
      // up front stays far from the memory ceiling this route exists to respect.
      const raw = await readInlineSource(fileId)
      inlineBytes = raw ? decodeInlineOriginal(raw) : null
      if (!inlineBytes) continue
    }
    const name = uniqueZipEntryName(
      humanOriginalDownloadName(row.name, row.format),
      used,
    )
    entries.push({
      name,
      open: async () => {
        if (inlineBytes) return inlineBytes
        if (r2Key) {
          return openOriginalSourceStream({ format, raw_source: null, r2_key: r2Key }, env.SNAPSHOTS)
        }
        // Legacy inline text, read only now so one row is resident at a time.
        return openOriginalSourceStream(
          { format, raw_source: await readInlineSource(fileId), r2_key: null },
          env.SNAPSHOTS,
        )
      },
    })
  }
  if (entries.length === 0) {
    return withCors(
      new Response("source bytes missing from storage — re-import", { status: 404 }),
      request,
    )
  }

  const project = await db
    .prepare(`SELECT name FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ name: string }>()
  const safe = (project?.name ?? "project").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  const zipName = `${safe || "project"}-originals.zip`

  return withCors(
    new Response(makeZipStream(entries), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentDisposition(zipName),
        "X-Content-Type-Options": "nosniff",
      },
    }),
    request,
  )
}
