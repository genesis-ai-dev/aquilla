// Bridge 1 of the Bible data layer: read and write `source_word_alignment` (AQU-1694).
//
//   GET  /api/v1/projects/:projectId/files/:fileId/source-word-alignment
//   POST /api/v1/projects/:projectId/files/:fileId/source-word-alignment
//
// The SPA aligns a book's source cells to the Bible Knowledge Pack in a Web
// Worker and uploads the links here (derived data, like cell_word_morph and
// its /import-morph route; no event kind). See migration 0152.
//
// WRITE (MAINTAINER+, the floor for project settings). Body:
//   { replace: "file" | "cells", method, trainedPairs,
//     cells: [{ cellId, sourceHash, links: [[wordId, token, conf], …] }] }
// A run sends its first chunk with replace "file" (which also clears rows of
// cells deleted since the last run) and the rest with "cells". Each request
// is one transaction. A cell whose `sourceHash` no longer matches the source
// row's `cells.content_hash` is refused and named in `stale`: the text
// changed while the browser was aligning it, so its links would be wrong.
//
// READ (any member). Every aligned cell of the file, grouped. A cell whose
// source text changed since it was aligned comes back `stale: true` with no
// links; a cell that no longer exists does not come back at all.

import { verifyTokenForDoc } from "../auth"
import { ROLE } from "./role-policy"

export interface SourceWordAlignmentEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/source-word-alignment$/

/** Cells and links one write may carry: a chunk of a book, not a book. */
export const MAX_ALIGNMENT_CELLS = 400
export const MAX_ALIGNMENT_LINKS = 12_000
/** Rows per INSERT: 9 bound values each, far below the driver's 65,534. */
const INSERT_ROWS = 500

const WORD_ID_RE = /^[no]\d{11,12}$/

/** [pack word id, source token index, confidence]. */
export type AlignmentLinkTuple = [string, number, number]

interface WriteCell {
  cellId: string
  sourceHash: string
  links: AlignmentLinkTuple[]
}

interface WriteBody {
  replace: "file" | "cells"
  method: string
  trainedPairs: number
  cells: WriteCell[]
}

export interface AlignedCellOut {
  cellId: string
  sourceHash: string
  method: string
  trainedPairs: number
  /** The source text changed since this cell was aligned; `links` is empty. */
  stale: boolean
  links: AlignmentLinkTuple[]
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max

function isLink(value: unknown): value is AlignmentLinkTuple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === "string" &&
    WORD_ID_RE.test(value[0]) &&
    isInt(value[1], 0, 100_000) &&
    typeof value[2] === "number" &&
    value[2] >= 0 &&
    value[2] <= 1
  )
}

/** The body, or a reason it is not one. */
export function parseWriteBody(body: unknown): WriteBody | string {
  if (typeof body !== "object" || body === null) return "body must be an object"
  const b = body as Record<string, unknown>
  if (b.replace !== "file" && b.replace !== "cells") return "replace must be \"file\" or \"cells\""
  if (typeof b.method !== "string" || b.method.length === 0 || b.method.length > 64) return "method must be a short string"
  if (!isInt(b.trainedPairs, 0, 1_000_000)) return "trainedPairs must be a non-negative integer"
  if (!Array.isArray(b.cells) || b.cells.length > MAX_ALIGNMENT_CELLS) return `cells must be an array of at most ${MAX_ALIGNMENT_CELLS}`
  let links = 0
  const seen = new Set<string>()
  for (const cell of b.cells as unknown[]) {
    if (typeof cell !== "object" || cell === null) return "each cell must be an object"
    const c = cell as Record<string, unknown>
    if (typeof c.cellId !== "string" || c.cellId.length === 0 || c.cellId.length > 128) return "cellId must be a string"
    if (seen.has(c.cellId)) return `cell ${c.cellId} appears twice`
    seen.add(c.cellId)
    if (typeof c.sourceHash !== "string" || !/^[0-9a-f]{8}$/.test(c.sourceHash)) return "sourceHash must be 8 hex digits"
    if (!Array.isArray(c.links) || !c.links.every(isLink)) return `cell ${c.cellId} has a malformed link`
    links += c.links.length
  }
  if (links > MAX_ALIGNMENT_LINKS) return `at most ${MAX_ALIGNMENT_LINKS} links per request`
  return b as unknown as WriteBody
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? ""
  return header.startsWith("Bearer ") ? header.slice(7) : null
}

export async function handleSourceWordAlignmentRequest(
  request: Request,
  env: SourceWordAlignmentEnv,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET" && request.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if (!env.AQUILLA_PG) return new Response("AQUILLA_PG binding not configured", { status: 500 })
  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])
  const auth = await verifyTokenForDoc(bearer(request), { projectId, fileId }, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })
  if (request.method === "GET") {
    if (auth.claims.role < ROLE.VIEWER) return new Response("not a member", { status: 403 })
    return readAlignment(env.AQUILLA_PG, projectId, fileId)
  }
  if (auth.claims.role < ROLE.MAINTAINER) return new Response("aligning the source needs the Maintainer role", { status: 403 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response("invalid JSON body", { status: 400 })
  }
  const parsed = parseWriteBody(body)
  if (typeof parsed === "string") return new Response(parsed, { status: 400 })
  return writeAlignment(env.AQUILLA_PG, projectId, fileId, parsed)
}

/** The source rows' current content hashes, for the cells named. */
async function currentHashes(db: AquillaDb, projectId: string, fileId: string, cellIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (cellIds.length === 0) return out
  const res = await db
    .prepare(
      `SELECT cell_id, content_hash FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' AND COALESCE(target_lang, '') = ''
          AND cell_id IN (${cellIds.map(() => "?").join(", ")})`,
    )
    .bind(projectId, fileId, ...cellIds)
    .all<{ cell_id: string; content_hash: string | null }>()
  for (const row of res.results ?? []) out.set(row.cell_id, row.content_hash)
  return out
}

async function writeAlignment(db: AquillaDb, projectId: string, fileId: string, body: WriteBody): Promise<Response> {
  const hashes = await currentHashes(db, projectId, fileId, body.cells.map((cell) => cell.cellId))
  const accepted = body.cells.filter((cell) => hashes.get(cell.cellId) === cell.sourceHash)
  const stale = body.cells.filter((cell) => hashes.get(cell.cellId) !== cell.sourceHash).map((cell) => cell.cellId)

  const stmts: AquillaStatement[] = []
  if (body.replace === "file") {
    // A new run for the file: rows of cells that no longer exist go now.
    stmts.push(
      db
        .prepare(
          `DELETE FROM source_word_alignment
            WHERE project_id = ? AND file_id = ?
              AND cell_id NOT IN (
                SELECT cell_id FROM cells
                 WHERE project_id = ? AND file_id = ? AND side = 'source' AND COALESCE(target_lang, '') = ''
              )`,
        )
        .bind(projectId, fileId, projectId, fileId),
    )
  }
  // Only accepted cells lose their old rows. A refused (stale) cell keeps
  // whatever it had: those rows may match the text this browser had not seen.
  if (accepted.length > 0) {
    stmts.push(
      db
        .prepare(
          `DELETE FROM source_word_alignment WHERE project_id = ? AND file_id = ?
             AND cell_id IN (${accepted.map(() => "?").join(", ")})`,
        )
        .bind(projectId, fileId, ...accepted.map((cell) => cell.cellId)),
    )
  }
  // One row per (cell, word, token): a repeated link keeps its highest confidence.
  const unique = new Map<string, unknown[]>()
  for (const cell of accepted) {
    for (const [wordId, token, conf] of cell.links) {
      const key = `${cell.cellId}\u0000${wordId}\u0000${token}`
      const held = unique.get(key)
      if (held && (held[5] as number) >= conf) continue
      unique.set(key, [projectId, fileId, cell.cellId, wordId, token, conf, body.method, cell.sourceHash, body.trainedPairs])
    }
  }
  const rows = [...unique.values()]
  for (let i = 0; i < rows.length; i += INSERT_ROWS) {
    const chunk = rows.slice(i, i + INSERT_ROWS)
    stmts.push(
      db
        .prepare(
          `INSERT INTO source_word_alignment
             (project_id, file_id, cell_id, src_word_id, tgt_token_idx, conf, method, source_hash, trained_pairs)
           VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
           ON CONFLICT (project_id, file_id, cell_id, src_word_id, tgt_token_idx) DO UPDATE SET
             conf = excluded.conf, method = excluded.method, source_hash = excluded.source_hash,
             trained_pairs = excluded.trained_pairs, created_at = now()`,
        )
        .bind(...chunk.flat()),
    )
  }
  try {
    if (stmts.length > 0) await db.batch(stmts)
  } catch (err) {
    console.error("[source-word-alignment] write failed:", err)
    return Response.json({ error: "write failed" }, { status: 500 })
  }
  return Response.json({ accepted: accepted.length, links: rows.length, stale })
}

interface ReadRow {
  cell_id: string
  src_word_id: string
  tgt_token_idx: number
  conf: number
  method: string
  source_hash: string
  trained_pairs: number
  current_hash: string | null
}

async function readAlignment(db: AquillaDb, projectId: string, fileId: string): Promise<Response> {
  // The inner join drops rows of cells that no longer exist.
  const res = await db
    .prepare(
      `SELECT a.cell_id, a.src_word_id, a.tgt_token_idx, a.conf, a.method, a.source_hash, a.trained_pairs,
              c.content_hash AS current_hash
         FROM source_word_alignment a
         JOIN cells c
           ON c.project_id = a.project_id AND c.file_id = a.file_id AND c.cell_id = a.cell_id
          AND c.side = 'source' AND COALESCE(c.target_lang, '') = ''
        WHERE a.project_id = ? AND a.file_id = ?
        ORDER BY a.cell_id, a.tgt_token_idx, a.src_word_id`,
    )
    .bind(projectId, fileId)
    .all<ReadRow>()
  const cells = new Map<string, AlignedCellOut>()
  for (const row of res.results ?? []) {
    let cell = cells.get(row.cell_id)
    if (!cell) {
      cell = {
        cellId: row.cell_id,
        sourceHash: row.source_hash,
        method: row.method,
        trainedPairs: Number(row.trained_pairs),
        stale: row.current_hash !== row.source_hash,
        links: [],
      }
      cells.set(row.cell_id, cell)
    }
    if (!cell.stale) cell.links.push([row.src_word_id, Number(row.tgt_token_idx), Math.round(Number(row.conf) * 1000) / 1000])
  }
  return Response.json({ cells: [...cells.values()] })
}
