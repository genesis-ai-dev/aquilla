// search — project-wide full-text search, as one call.
//
// Sides: source/target cells (tsvector via websearch_to_tsquery — safe for
// arbitrary user text), comments (ILIKE), terms (the project_settings
// terminology JSON, matched in JS). Default searches both cell sides.

import { AliasMap } from "../compress"
import { clip } from "./read"
import type { SearchHit, ToolOutcome } from "./types"

export interface SearchArgs {
  q?: unknown
  side?: unknown
  fileId?: unknown
  limit?: unknown
}

export interface SearchContext {
  projectId: string
  focusedFileId?: string
  aliases: AliasMap
}

const SIDES = new Set(["cells", "source", "target", "comments", "terms"])
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

interface CellHit {
  cell_id: string
  file_id: string
  canonical_ref: string | null
  side: string
  value: string
}

async function searchCells(
  db: AquillaDb,
  q: string,
  ctx: SearchContext,
  side: "source" | "target" | "both",
  fileId: string | undefined,
  limit: number,
): Promise<SearchHit[]> {
  const conditions = ["project_id = ?", "value_tsv @@ websearch_to_tsquery('simple', ?)"]
  const binds: unknown[] = [ctx.projectId, q]
  if (side !== "both") {
    conditions.push("side = ?")
    binds.push(side)
  }
  if (fileId) {
    conditions.push("file_id = ?")
    binds.push(fileId)
  }
  binds.push(limit)
  const { results } = await db
    .prepare(
      `SELECT cell_id, file_id, canonical_ref, side, value FROM cells
       WHERE ${conditions.join(" AND ")}
       ORDER BY ts_rank(value_tsv, websearch_to_tsquery('simple', ?)) DESC
       LIMIT ?`,
    )
    .bind(...binds.slice(0, -1), q, limit)
    .all<CellHit>()
  return results.map((r) => ({
    cellId: r.cell_id,
    fileId: r.file_id,
    ref: r.canonical_ref ?? undefined,
    side: r.side as "source" | "target",
    snippet: r.value.slice(0, 200),
  }))
}

async function searchComments(
  db: AquillaDb,
  q: string,
  ctx: SearchContext,
  limit: number,
): Promise<SearchHit[]> {
  const { results } = await db
    .prepare(
      `SELECT comment_id, file_id, cell_id, body FROM comments
       WHERE project_id = ? AND deleted_at IS NULL AND body ILIKE ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(ctx.projectId, `%${q}%`, limit)
    .all<{ comment_id: string; file_id: string | null; cell_id: string | null; body: string }>()
  return results.map((r) => ({
    cellId: r.cell_id ?? r.comment_id,
    fileId: r.file_id ?? undefined,
    side: "comments" as const,
    snippet: r.body.slice(0, 200),
  }))
}

async function searchTerms(db: AquillaDb, q: string, ctx: SearchContext, limit: number): Promise<SearchHit[]> {
  const row = await db
    .prepare("SELECT settings FROM project_settings WHERE project_id = ?")
    .bind(ctx.projectId)
    .first<{ settings: string }>()
  if (!row) return []
  let concepts: unknown[] = []
  try {
    const settings = JSON.parse(row.settings) as { terminology?: { concepts?: unknown[] } }
    concepts = settings.terminology?.concepts ?? []
  } catch {
    return []
  }
  const needle = q.toLowerCase()
  const hits: SearchHit[] = []
  for (const raw of concepts) {
    if (hits.length >= limit) break
    const text = JSON.stringify(raw)
    if (text.toLowerCase().includes(needle)) {
      hits.push({ cellId: "", side: "terms", snippet: text.slice(0, 200) })
    }
  }
  return hits
}

export async function executeSearch(db: AquillaDb, args: SearchArgs, ctx: SearchContext): Promise<ToolOutcome> {
  if (typeof args.q !== "string" || !args.q.trim()) {
    return { ok: false, text: "error: search needs a non-empty q" }
  }
  const q = args.q.trim()
  const side = typeof args.side === "string" ? args.side : "cells"
  if (!SIDES.has(side)) {
    return { ok: false, text: `error: unknown side "${side}" — one of ${[...SIDES].join(" | ")}` }
  }
  const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT)

  let fileId: string | undefined
  if (typeof args.fileId === "string") {
    if (args.fileId === ":file") fileId = ctx.focusedFileId
    else if (AliasMap.isAlias(args.fileId)) fileId = ctx.aliases.resolve(args.fileId)
    else fileId = args.fileId
    if (!fileId) return { ok: false, text: `error: could not resolve fileId ${String(args.fileId)}` }
  }

  let hits: SearchHit[]
  try {
    if (side === "comments") hits = await searchComments(db, q, ctx, limit)
    else if (side === "terms") hits = await searchTerms(db, q, ctx, limit)
    else if (side === "source" || side === "target") hits = await searchCells(db, q, ctx, side, fileId, limit)
    else hits = await searchCells(db, q, ctx, "both", fileId, limit)
  } catch (err) {
    return { ok: false, text: `error: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (hits.length === 0) {
    return { ok: true, text: `No matches for "${q}" (side: ${side}).`, data: { hits: [] } }
  }

  const lines = ["cell|ref|side|snippet"]
  for (const h of hits) {
    lines.push(
      [
        h.cellId ? ctx.aliases.alias(h.cellId, "c") : "∅",
        h.ref ?? "∅",
        h.side,
        clip(h.snippet),
      ].join("|"),
    )
  }
  lines.push(`(${hits.length} hit${hits.length === 1 ? "" : "s"})`)
  return { ok: true, text: lines.join("\n"), data: { hits } }
}
