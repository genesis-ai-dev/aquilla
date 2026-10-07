// search — project-wide full-text search, as one call.
//
// Sides: source/target cells (tsvector via websearch_to_tsquery — safe for
// arbitrary user text), comments (ILIKE), terms (the project's live concepts,
// read as the editor reads them, matched in JS). Default searches both cell
// sides.

import { readBlobConcepts } from "../../../../../sync-worker/src/events/migrate-concepts"
import { AliasMap } from "../compress"
import { resolveLaneIdOrTag } from "../../../../../db/shared/lane-ref"
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

/** A key term, from the `concepts` table or the legacy settings key. */
interface Term {
  sourceTerm: string
  status: "active" | "draft" | "deprecated"
  renderings: { rendering: string; status: string }[]
  notes: string | null
}

const RENDERING_STATUSES = new Set(["preferred", "admitted", "forbidden"])

/** `renderings` is JSONB: an array through the shim, but a hand-written row can
 *  return text. A bad value gives no renderings instead of failing the whole
 *  search, as in the editor's read route. */
function parseRenderings(raw: unknown): Term["renderings"] {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((r: unknown) => {
    const { rendering, status } = (r ?? {}) as { rendering?: unknown; status?: unknown }
    return typeof rendering === "string" && typeof status === "string" && RENDERING_STATUSES.has(status)
      ? [{ rendering, status }]
      : []
  })
}

/**
 * The project's key terms, read the way the editor reads them
 * (sync-worker/src/events/concepts-read-route.ts): the live rows of the
 * `concepts` table, which is the projection of `term.*` events. The legacy
 * `terminology` settings key (a bare Concept[]) is read only when the table has
 * no live rows, through the decoder the editor's fallback uses. The concepts
 * migration deletes that key, and a key left behind must not add terms next to
 * the table's or bring a deleted term back.
 */
async function loadTerms(db: AquillaDb, projectId: string): Promise<Term[]> {
  const { results } = await db
    .prepare(
      `SELECT source_term, renderings, notes, status FROM concepts
       WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC`,
    )
    .bind(projectId)
    .all<{ source_term: string; renderings: unknown; notes: string | null; status: string }>()
  if (results.length === 0) return readBlobConcepts(db, projectId)
  return results.map((r) => ({
    sourceTerm: r.source_term,
    status: r.status === "active" || r.status === "deprecated" ? r.status : "draft",
    renderings: parseRenderings(r.renderings),
    notes: r.notes,
  }))
}

/** Only an active concept compiles to rules (the editor's checks, autopilot's
 *  lint), so a draft or deprecated hit says that it is not enforced. */
const TERM_STATUS_LABEL: Record<Term["status"], string> = {
  active: "active",
  draft: "draft, not enforced",
  deprecated: "deprecated, not enforced",
}

/** "[active] grace → gracia (preferred), suerte (forbidden) — notes". The
 *  status comes first, so a clipped line always keeps it. */
function termSnippet(t: Term): string {
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
async function searchTerms(db: AquillaDb, q: string, ctx: SearchContext, limit: number): Promise<SearchHit[]> {
  const needle = q.toLowerCase()
  const hits: SearchHit[] = []
  for (const term of await loadTerms(db, ctx.projectId)) {
    if (hits.length >= limit) break
    const text = [term.sourceTerm, ...term.renderings.map((r) => r.rendering), term.notes ?? ""]
    if (text.some((s) => s.toLowerCase().includes(needle))) {
      hits.push({ cellId: "", side: "terms", snippet: termSnippet(term).slice(0, 200) })
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
