// search — project-wide full-text search, as one call.
//
// Sides: source/target cells (tsvector via websearch_to_tsquery — safe for
// arbitrary user text), comments (ILIKE), terms (the project's live concepts,
// read as the editor reads them, matched in JS). Default searches both cell
// sides.

import { readProjectConcepts, type StoredConcept } from "../../concepts-read"
import { AliasMap } from "../compress"
import { resolveLane, resolveLaneIdOrTag } from "../../../../../db/shared/lane-ref"
import { renderingsForLane } from "../../../../../src/lib/terminology/rendering-lane"
import { notHiddenSql } from "../../hidden-cells-scope"
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
  /** The active lane, as either its `lanes.id` or its legacy tag: resolved
   *  to the id every lane-scoped query keys on (AQU-1610). `''` is the
   *  project's former default lane. */
  lane: string
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
  // AQU-1424: parked cells are not searchable. The anti-join rather than a bare
  // hidden_at IS NULL, because this query matches EITHER side and the flag lives
  // only on the shared source row. When searching target cells, scope to the
  // active lane only.
  const conditions = [
    "project_id = ?",
    "value_tsv @@ websearch_to_tsquery('simple', ?)",
    notHiddenSql(),
  ]
  const { laneId } = await resolveLaneIdOrTag(db, ctx.projectId, ctx.lane)
  const binds: unknown[] = [ctx.projectId, q]
  if (side !== "both") {
    conditions.push("side = ?")
    binds.push(side)
  }
  if (side === "target") {
    conditions.push("lane_id = ?")
    binds.push(laneId)
  } else if (side === "both") {
    // A source row belongs to the SOURCE lane, so only target rows are scoped
    // here — a bare lane filter would drop every source hit in any lane but
    // the one being searched.
    conditions.push("(side = 'source' OR lane_id = ?)")
    binds.push(laneId)
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

/** Only an active concept compiles to rules (the editor's checks, autopilot's
 *  lint), so a draft or deprecated hit says that it is not enforced. */
const TERM_STATUS_LABEL: Record<StoredConcept["status"], string> = {
  active: "active",
  draft: "draft, not enforced",
  deprecated: "deprecated, not enforced",
}

/** "[active] grace → gracia (preferred), suerte (forbidden) — notes". The
 *  status comes first, so a clipped line always keeps it. */
function termSnippet(t: StoredConcept): string {
  const renderings = t.renderings.map((r) => `${r.rendering} (${r.status})`).join(", ")
  return `[${TERM_STATUS_LABEL[t.status]}] ${t.sourceTerm}` +
    (renderings ? ` → ${renderings}` : "") +
    (t.notes ? ` — ${t.notes}` : "")
}

// AQU-1714: every live concept is searchable, drafts and deprecated terms
// included. Search is not enforcement. The editor's checks and autopilot's lint
// use active concepts only, but the agent searches the termbase to learn what
// the team has decided or proposed. Without drafts, it would report that the
// team has not addressed a term that is waiting for review. Without deprecated
// terms, it would lose the record that a rendering was retired on purpose, and
// it could suggest that rendering again. Each hit carries its status, so a
// proposal or a retired term never reads as binding. Matching uses the text
// the team wrote (source term, renderings, notes), not ids or status labels.
//
// The terms are read as the editor reads them, through the same function as
// autopilot and the termbase subscription route (readProjectConcepts): the
// live `concepts` rows, and the legacy settings key only while there are none.
// The concepts migration deletes that key, so a key left behind never adds
// terms next to the table's or brings a deleted term back.
async function searchTerms(db: AquillaDb, q: string, ctx: SearchContext, limit: number): Promise<SearchHit[]> {
  const needle = q.toLowerCase()
  const hits: SearchHit[] = []
  const empty = await resolveLane(db, ctx.projectId, { targetLang: "" })
  const active = await resolveLaneIdOrTag(db, ctx.projectId, ctx.lane)
  for (const term of await readProjectConcepts(db, ctx.projectId)) {
    const renderings = !empty.laneId
      ? term.renderings
      : !active.laneId
        ? []
        : renderingsForLane(term.renderings, active.laneId, empty.laneId)
    const visible = renderings === term.renderings ? term : { ...term, renderings }
    if (hits.length >= limit) break
    const text = [visible.sourceTerm, ...visible.renderings.map((r) => r.rendering), visible.notes ?? ""]
    if (text.some((s) => s.toLowerCase().includes(needle))) {
      hits.push({ cellId: "", side: "terms", snippet: termSnippet(visible).slice(0, 200) })
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
