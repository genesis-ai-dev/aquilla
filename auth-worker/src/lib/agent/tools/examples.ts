// examples — few-shot retrieval, as one call.
//
// This is the copilot's example-gathering encoded server-side: given a source
// text (or cell ids), return approved translation pairs to imitate, ranked by
// FTS similarity. Unreviewed drafts are never eligible for generation context.
// The old flow made the model derive this JOIN by hand
// every run; now it is one tool call and always the same, correct retrieval.

import { AliasMap } from "../compress"
import { clip } from "./read"
import type { ExamplePair, ToolOutcome } from "./types"

export interface ExamplesArgs {
  text?: unknown
  cellIds?: unknown
  n?: unknown
}

export interface ExamplesContext {
  projectId: string
  aliases: AliasMap
}

const DEFAULT_N = 6
const MAX_N = 12
const MAX_QUERY_WORDS = 12

/** Build a `simple`-config OR tsquery from free text; null when no lexemes. */
export function orTsquery(text: string): string | null {
  const words = [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .map((w) => w.replace(/'/g, ""))
        .filter((w) => w.length > 1),
    ),
  ].slice(0, MAX_QUERY_WORDS)
  if (words.length === 0) return null
  return words.map((w) => `'${w}'`).join(" | ")
}

interface PairHit {
  cell_id: string
  canonical_ref: string | null
  source_value: string
  target_value: string
  validated: number | null
}

export async function executeExamples(
  db: AquillaDb,
  args: ExamplesArgs,
  ctx: ExamplesContext,
): Promise<ToolOutcome> {
  const n = Math.min(Math.max(Number(args.n) || DEFAULT_N, 1), MAX_N)

  // Query text: free text, or the source values of the given cells/aliases.
  let queryText = typeof args.text === "string" ? args.text : ""
  if (!queryText && Array.isArray(args.cellIds)) {
    const ids: string[] = []
    for (const raw of args.cellIds.slice(0, 10)) {
      if (typeof raw !== "string") continue
      ids.push(AliasMap.isAlias(raw) ? (ctx.aliases.resolve(raw) ?? "") : raw)
    }
    const bound = ids.filter(Boolean)
    if (bound.length > 0) {
      const placeholders = bound.map(() => "?").join(", ")
      const { results } = await db
        .prepare(
          `SELECT value FROM cells
           WHERE project_id = ? AND side = 'source' AND cell_id IN (${placeholders})`,
        )
        .bind(ctx.projectId, ...bound)
        .all<{ value: string }>()
      queryText = results.map((r) => r.value).join(" ")
    }
  }

  const tsquery = queryText ? orTsquery(queryText) : null

  // Only validated pairs are trusted. With no usable query, fall back to the
  // most recently touched validated pairs.
  const { results } = tsquery
    ? await db
        .prepare(
          `SELECT t.cell_id, t.canonical_ref, s.value AS source_value, t.value AS target_value, t.validated
           FROM cells t
           JOIN cells s ON s.project_id = t.project_id AND s.file_id = t.file_id
                       AND s.cell_id = t.cell_id AND s.side = 'source'
           WHERE t.project_id = ? AND t.side = 'target' AND t.value <> ''
             AND t.validated = 1
             AND s.value_tsv @@ to_tsquery('simple', ?)
           ORDER BY ts_rank(s.value_tsv, to_tsquery('simple', ?)) DESC
           LIMIT ?`,
        )
        .bind(ctx.projectId, tsquery, tsquery, n)
        .all<PairHit>()
    : await db
        .prepare(
          `SELECT t.cell_id, t.canonical_ref, s.value AS source_value, t.value AS target_value, t.validated
           FROM cells t
           JOIN cells s ON s.project_id = t.project_id AND s.file_id = t.file_id
                       AND s.cell_id = t.cell_id AND s.side = 'source'
           WHERE t.project_id = ? AND t.side = 'target' AND t.value <> '' AND t.validated = 1
           ORDER BY t.last_edit_at DESC
           LIMIT ?`,
        )
        .bind(ctx.projectId, n)
        .all<PairHit>()

  if (results.length === 0) {
    return {
      ok: true,
      text: "No approved translation pairs match — the project may be new. Draft from the brief and language pair alone.",
      data: { examples: [] },
    }
  }

  const pairs: ExamplePair[] = results.map((r) => ({
    cellId: r.cell_id,
    ref: r.canonical_ref ?? undefined,
    source: r.source_value,
    target: r.target_value,
    validated: Number(r.validated ?? 0) === 1,
  }))

  const lines = ["ref|validated|source|target"]
  for (const p of pairs) {
    lines.push([p.ref ?? "∅", p.validated ? "✓" : "·", clip(p.source), clip(p.target)].join("|"))
  }
  lines.push(`(${pairs.length} approved pair${pairs.length === 1 ? "" : "s"} — imitate their terminology and style)`)

  return { ok: true, text: lines.join("\n"), data: { examples: pairs } }
}
