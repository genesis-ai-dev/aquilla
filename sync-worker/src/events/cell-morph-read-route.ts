// Per-cell original-language morphology read. (AQU-462)
//
//   GET /api/v1/projects/:projectId/files/:fileId/morph?cellIds=a,b,c
//
// The write side of `cell_word_morph` has existed since AQU-178 (Macula Hebrew
// + Greek import writes one row per original-language word). Nothing could read
// it back, so the morphology the importer had already paid for was invisible to
// the translator: the interlinear panel aligned bare inflected surface forms and
// had no lemma to fall back on. This is that read.
//
// Bounded by construction. A Macula book is tens of thousands of words, and the
// caller is one expanded cell's alignment panel, so `cellIds` is REQUIRED and
// capped — a whole-file morph dump has no caller today and would be a multi-MB
// response on a route a translator hits every time they open a row.
//
// Auth: sync-token JWT scoped to projectId; viewer (100) and up — the same
// floor as the cells / cell-links / audio-attachment reads. Morphology is a
// property of the source text, so anyone who may read the cell may read it.

import { verifyTokenForProject } from "../auth"

export interface CellMorphReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)\/morph$/

/** Max cell ids accepted in one request. One expanded row asks for one cell;
 *  the headroom is for a future strip of visible rows, not a file dump. */
export const MAX_MORPH_CELL_IDS = 50

interface MorphRowRaw {
  cell_id: string
  word_seq: number
  surface: string
  lemma: string | null
  morph_code: string | null
  strongs_h: string | null
  strongs_g: string | null
}

/** One original-language word, as the client consumes it. */
export interface MorphWordOut {
  cellId: string
  wordSeq: number
  surface: string
  lemma?: string
  morphCode?: string
  /** Strong's number for whichever testament this word belongs to. */
  strongsH?: string
  strongsG?: string
}

export async function handleCellMorphReadRequest(
  request: Request,
  env: CellMorphReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])
  const fileId = decodeURIComponent(match[2])

  const cellIds = (url.searchParams.get("cellIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)

  if (cellIds.length === 0) {
    return new Response("cellIds query parameter is required", { status: 400 })
  }
  if (cellIds.length > MAX_MORPH_CELL_IDS) {
    return new Response(`cellIds exceeds ${MAX_MORPH_CELL_IDS}`, { status: 400 })
  }

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const placeholders = cellIds.map(() => "?").join(", ")
  const res = await env.AQUILLA_PG.prepare(
    `SELECT cell_id, word_seq, surface, lemma, morph_code, strongs_h, strongs_g
       FROM cell_word_morph
      WHERE project_id = ? AND file_id = ? AND cell_id IN (${placeholders})
      ORDER BY cell_id, word_seq`,
  )
    .bind(projectId, fileId, ...cellIds)
    .all<MorphRowRaw>()

  const words: MorphWordOut[] = (res.results ?? []).map((r) => {
    const out: MorphWordOut = {
      cellId: r.cell_id,
      wordSeq: r.word_seq,
      surface: r.surface,
    }
    if (r.lemma) out.lemma = r.lemma
    if (r.morph_code) out.morphCode = r.morph_code
    if (r.strongs_h) out.strongsH = r.strongs_h
    if (r.strongs_g) out.strongsG = r.strongs_g
    return out
  })

  return Response.json({ words })
}
