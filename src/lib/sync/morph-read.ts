// Typed fetch wrapper for the original-language morphology read. (AQU-462)
//
//   GET /api/v1/projects/:projectId/files/:fileId/morph?cellIds=a,b,c
//
// One row per word of a Macula Hebrew/Greek source cell: the surface form the
// translator sees, plus the lemma, morphology code and Strong's number the
// importer already stored. The lemma is the part that earns its keep — Hebrew
// and Greek inflect so heavily that a surface form often occurs once in a book,
// which is exactly when a co-occurrence alignment model has nothing to say
// about it and the lemma still does (see completion/macula-align.ts).
//
// Ask for the cells on screen, never a file: the route caps `cellIds`.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { timeoutSignal } from "./fetch-timeout"

/** One original-language word of a source cell, in text order. */
export interface MorphWord {
  cellId: string
  /** 1-based position within the cell. */
  wordSeq: number
  /** Surface form as it appears in the verse. */
  surface: string
  /** Dictionary/lexical form, when the corpus carries one. */
  lemma?: string
  /** Morphology code (Macula/OSHB/Robinson shape, corpus-dependent). */
  morphCode?: string
  strongsH?: string
  strongsG?: string
}

export interface MorphReadResponse {
  words: MorphWord[]
}

export class MorphReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`morph read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "MorphReadError"
  }
}

export interface FetchCellMorphArgs {
  projectId: string
  fileId: string
  cellIds: string[]
  jwt: string
  signal?: AbortSignal
}

const MORPH_READ_TIMEOUT_MS = 15_000

/** Fetch the morphology rows for a batch of cells. Empty `cellIds` never
 *  reaches the network — an empty ask has an empty answer. */
export async function fetchCellMorph(args: FetchCellMorphArgs): Promise<MorphWord[]> {
  if (args.cellIds.length === 0) return []

  const qs = new URLSearchParams({ cellIds: args.cellIds.join(",") })
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}` +
    `/files/${encodeURIComponent(args.fileId)}/morph?${qs.toString()}`

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${args.jwt}` },
    signal: args.signal ?? timeoutSignal(MORPH_READ_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new MorphReadError(res.status, body)
  }
  const parsed = (await res.json()) as MorphReadResponse
  return parsed.words ?? []
}

/**
 * Group a flat morph list by cell id, each cell's words sorted by `wordSeq`.
 *
 * The route already orders rows, but a caller that merges two responses (or
 * replays a cache) must not depend on that, and word order is load-bearing:
 * the alignment adapter maps word N of the cell to token N of the verse.
 */
export function indexMorphByCell(words: readonly MorphWord[]): Map<string, MorphWord[]> {
  const byCell = new Map<string, MorphWord[]>()
  for (const w of words) {
    const existing = byCell.get(w.cellId)
    if (existing) existing.push(w)
    else byCell.set(w.cellId, [w])
  }
  for (const list of byCell.values()) list.sort((a, b) => a.wordSeq - b.wordSeq)
  return byCell
}
