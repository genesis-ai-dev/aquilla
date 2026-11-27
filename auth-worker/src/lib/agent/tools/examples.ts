// examples — few-shot retrieval, as one call.
//
// This is the copilot's example-gathering encoded server-side: given a source
// text (or cell ids), return approved translation pairs to imitate, ranked by
// FTS similarity. Unreviewed drafts are never eligible for generation context.
// The old flow made the model derive this JOIN by hand
// every run; now it is one tool call and always the same, correct retrieval.

import { AliasMap } from "../compress"
import { resolveLaneIdOrTag } from "../../../../../db/shared/lane-ref"
import { loadProjectVirtualSourceFiles, type ManifestR2Bucket } from "../../../../../db/shared/virtual-source-store"
import { clip } from "./read"
import type { ExamplePair, ToolOutcome } from "./types"

export interface ExamplesArgs {
  text?: unknown
  cellIds?: unknown
  n?: unknown
}

export interface ExamplesContext {
  projectId: string
  /** The active lane, as either its `lanes.id` or its legacy tag: resolved
   *  to the id every lane-scoped query keys on (AQU-1610). `''` is the
   *  project's former default lane. */
  lane: string
  aliases: AliasMap
  /** AQU-2459 Phase B: R2 bucket for virtual source files. */
  r2?: ManifestR2Bucket
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

  // Preload virtual files once if needed (used both for cellIds query text and pair matching).
  const vFiles = ctx.r2 ? await loadProjectVirtualSourceFiles(db, ctx.r2, ctx.projectId) : []

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
      const pieces = results.map((r) => r.value)
      if (pieces.length < bound.length && vFiles.length > 0) {
        const wanted = new Set(bound)
        for (const vf of vFiles) {
          for (const id of wanted) {
            const vr = vf.byCellId.get(id)
            if (vr) pieces.push(vr.value)
          }
        }
      }
      queryText = pieces.join(" ")
    }
  }

  const tsquery = queryText ? orTsquery(queryText) : null

  // Only validated pairs are trusted. With no usable query, fall back to the
  // most recently touched validated pairs. Filter by lane to ensure examples
  // come from the active translation lane only — by `lane_id` (AQU-1610), so
  // a second lane of the same language cannot be shown the first's examples.
  const { laneId } = await resolveLaneIdOrTag(db, ctx.projectId, ctx.lane)
  const { results } = tsquery
    ? await db
        .prepare(
          `SELECT t.cell_id, t.canonical_ref, s.value AS source_value, t.value AS target_value, t.validated
           FROM cells t
           JOIN cells s ON s.project_id = t.project_id AND s.file_id = t.file_id
                       AND s.cell_id = t.cell_id AND s.side = 'source'
           WHERE t.project_id = ? AND t.side = 'target' AND t.lane_id = ? AND t.value <> ''
             AND t.validated = 1
             AND s.value_tsv @@ to_tsquery('simple', ?)
           ORDER BY ts_rank(s.value_tsv, to_tsquery('simple', ?)) DESC
           LIMIT ?`,
        )
        .bind(ctx.projectId, laneId, tsquery, tsquery, n)
        .all<PairHit>()
    : await db
        .prepare(
          `SELECT t.cell_id, t.canonical_ref, s.value AS source_value, t.value AS target_value, t.validated
           FROM cells t
           JOIN cells s ON s.project_id = t.project_id AND s.file_id = t.file_id
                       AND s.cell_id = t.cell_id AND s.side = 'source'
           WHERE t.project_id = ? AND t.side = 'target' AND t.lane_id = ? AND t.value <> '' AND t.validated = 1
           ORDER BY t.last_edit_at DESC
           LIMIT ?`,
        )
        .bind(ctx.projectId, laneId, n)
        .all<PairHit>()

  const merged: PairHit[] = [...results]
  if (vFiles.length > 0 && merged.length < n) {
    const vFileIds = vFiles.map((vf) => vf.head.fileId)
    const vByFile = new Map(vFiles.map((vf) => [vf.head.fileId, vf]))
    const ph = vFileIds.map(() => "?").join(", ")
    const vTargets = await db
      .prepare(
        `SELECT file_id, cell_id, canonical_ref, value, validated, last_edit_at
           FROM cells
          WHERE project_id = ? AND side = 'target' AND lane_id = ? AND value <> '' AND validated = 1
            AND file_id IN (${ph})
          ORDER BY last_edit_at DESC
          LIMIT 500`,
      )
      .bind(ctx.projectId, laneId, ...vFileIds)
      .all<{
        file_id: string
        cell_id: string
        canonical_ref: string | null
        value: string
        validated: number | null
        last_edit_at: number | string
      }>()
    const queryWords = queryText
      ? new Set(
          queryText
            .toLowerCase()
            .split(/[^\p{L}\p{N}']+/u)
            .map((w) => w.replace(/'/g, ""))
            .filter((w) => w.length > 1),
        )
      : null
    const seenIds = new Set(merged.map((m) => m.cell_id))
    const scored: Array<{ hit: PairHit; score: number; ts: number }> = []
    for (const t of vTargets.results ?? []) {
      if (seenIds.has(t.cell_id)) continue
      const vsrc = vByFile.get(t.file_id)?.byCellId.get(t.cell_id)
      if (!vsrc || vsrc.hidden_at != null || vsrc.tombstoned_at != null) continue
      let score = 0
      if (queryWords && queryWords.size > 0) {
        const srcWords = vsrc.value
          .toLowerCase()
          .split(/[^\p{L}\p{N}']+/u)
          .map((w) => w.replace(/'/g, ""))
        for (const w of srcWords) if (queryWords.has(w)) score += 1
        if (score === 0) continue
      }
      seenIds.add(t.cell_id)
      scored.push({
        score,
        ts: Number(t.last_edit_at ?? 0),
        hit: {
          cell_id: t.cell_id,
          canonical_ref: t.canonical_ref ?? vsrc.canonical_ref,
          source_value: vsrc.value,
          target_value: t.value,
          validated: t.validated,
        },
      })
    }
    scored.sort((a, b) => b.score - a.score || b.ts - a.ts)
    for (const s of scored) {
      if (merged.length >= n) break
      merged.push(s.hit)
    }
  }

  if (merged.length === 0) {
    return {
      ok: true,
      text: "No approved translation pairs match — the project may be new. Draft from the brief and language pair alone.",
      data: { examples: [] },
    }
  }

  const pairs: ExamplePair[] = merged.map((r) => ({
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
