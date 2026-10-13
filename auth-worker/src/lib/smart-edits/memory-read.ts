/**
 * smart-edits/memory-read.ts — the I/O around the pure tier-0 scorer in
 * src/lib/smart-edits/suggest.ts: load the observations a passage could match,
 * then the counter-evidence its candidates need (keeps, reverts, dismissals).
 */

import type { AquillaDb } from "../../../../db/shim/postgres"
import {
  dismissKey,
  keepKey,
  type Candidate,
  type Observation,
  type ScoreInputs,
} from "../../../../src/lib/smart-edits/suggest"
import { phraseKey, tokenize } from "../../../../src/lib/smart-edits/tokens"
import { MAX_OLD_TOKENS } from "../../../../src/lib/smart-edits/extract"
import { CELL_KEY_SEP, cellKeyOf } from "./miner"

/** Cap on observations read for one passage — the newest win. */
const MAX_OBSERVATIONS = 4000
/** Cap on distinct (phrase, anchors) keep counts per request. */
const MAX_KEEP_QUERIES = 40

interface ObservationRow {
  id: string
  file_id: string
  cell_id: string
  lane: string
  after_event_id: string
  ts: number
  before_origin: Observation["beforeOrigin"]
  bulk_key: string | null
  old: string
  old_norm: string
  new: string
  new_norm: string
  left_ctx: string
  right_ctx: string
  source_norms: string
  source_text: string
  before_text: string
  after_text: string
}

function parseList(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** Every 1..MAX_OLD_TOKENS-gram key in the passage's target text. */
export function passagePhraseKeys(targets: readonly string[]): string[] {
  const keys = new Set<string>()
  for (const t of targets) {
    const norms = tokenize(t).map((x) => x.norm)
    for (let i = 0; i < norms.length; i++) {
      for (let n = 1; n <= MAX_OLD_TOKENS && i + n <= norms.length; n++) keys.add(phraseKey(norms.slice(i, i + n)))
    }
  }
  return [...keys]
}

export async function loadObservations(
  db: AquillaDb,
  projectId: string,
  lane: string,
  phraseKeys: readonly string[],
): Promise<Observation[]> {
  if (phraseKeys.length === 0) return []
  const placeholders = phraseKeys.map(() => "?").join(",")
  const { results } = await db
    .prepare(
      `SELECT id, file_id, cell_id, lane, after_event_id, ts, before_origin, bulk_key, old, old_norm,
              new, new_norm, left_ctx, right_ctx, source_norms, source_text, before_text, after_text
         FROM smart_edit_observations o
        WHERE o.project_id = ? AND o.lane = ? AND o.old_norm IN (${placeholders})
          -- An accepted suggestion lands as an ordinary human commit; counting
          -- it as fresh evidence would let every suggestion vote for itself.
          AND NOT EXISTS (
            SELECT 1 FROM smart_edit_feedback f
             WHERE f.project_id = o.project_id AND f.lane = o.lane AND f.action = 'accept'
               AND f.file_id = o.file_id AND f.cell_id = o.cell_id
               AND f.old_norm = o.old_norm AND f.new_norm = o.new_norm)
        ORDER BY o.ts DESC LIMIT ?`,
    )
    .bind(projectId, lane, ...phraseKeys, MAX_OBSERVATIONS)
    .all<ObservationRow>()
  return results.map((r) => ({
    id: r.id,
    cellKey: cellKeyOf(r.file_id, r.cell_id, r.lane),
    afterId: r.after_event_id,
    ts: Number(r.ts),
    beforeOrigin: r.before_origin,
    bulkKey: r.bulk_key,
    old: r.old,
    oldNorm: r.old_norm,
    new: r.new,
    newNorm: r.new_norm,
    left: parseList(r.left_ctx),
    right: parseList(r.right_ctx),
    sourceNorms: parseList(r.source_norms),
    sourceText: r.source_text,
    beforeText: r.before_text,
    afterText: r.after_text,
  }))
}

/** tsquery-safe: keep letters/marks/digits only, so a token can never inject
 *  tsquery operators. */
function tsWord(token: string): string {
  return token.replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim()
}

export async function loadScoreInputs(
  db: AquillaDb,
  projectId: string,
  lane: string,
  candidates: readonly Candidate[],
  observations: readonly Observation[],
): Promise<ScoreInputs> {
  // Keeps — human-confirmed target cells that still contain the phrase (and,
  // for an anchored edit, whose source has the anchor tokens). A cell whose
  // current value is an unreviewed AI draft is not a human keeping anything.
  // The suggested cell itself counts when a person confirmed its text: the
  // wording standing there is a keep too, and erring that way favours
  // precision, which is the side a suggestion UI must err on.
  const keepSpecs = new Map<string, { oldNorm: string; anchors: string[] }>()
  for (const c of candidates) {
    for (const r of c.replacements) {
      const k = keepKey(c.oldNorm, r.anchors)
      if (!keepSpecs.has(k) && keepSpecs.size < MAX_KEEP_QUERIES) keepSpecs.set(k, { oldNorm: c.oldNorm, anchors: r.anchors })
    }
  }
  const keeps = new Map<string, number>()
  const specs = [...keepSpecs.entries()].filter(([, s]) => tsWord(s.oldNorm).length > 0)
  if (specs.length > 0) {
    const stmts = specs.map(([, s]) => {
      const anchors = s.anchors.map(tsWord).filter(Boolean)
      const anchorSql = anchors.length
        ? `AND EXISTS (SELECT 1 FROM cells src WHERE src.project_id = t.project_id AND src.file_id = t.file_id
              AND src.cell_id = t.cell_id AND src.side = 'source'
              AND src.value_tsv @@ plainto_tsquery('simple', ?))`
        : ""
      return db
        .prepare(
          `SELECT COUNT(*)::int AS n FROM cells t
            WHERE t.project_id = ? AND t.side = 'target'
              AND t.lane_id = (SELECT id FROM public.lanes WHERE project_id = t.project_id AND role = 'target' AND legacy_tag = ?)
              AND t.tombstoned_at IS NULL AND (t.validated > 0 OR t.ai_drafted = 0)
              AND t.value_tsv @@ phraseto_tsquery('simple', ?) ${anchorSql}`,
        )
        .bind(projectId, lane, tsWord(s.oldNorm), ...(anchors.length ? [anchors.join(" ")] : []))
    })
    const res = await db.batch<{ n: number }>(stmts)
    specs.forEach(([k], i) => keeps.set(k, Number(res[i]?.results[0]?.n ?? 0)))
  }

  // Reverts — an observation whose cell no longer contains its replacement.
  // Only observations backing a candidate are checked.
  const backing = new Set(candidates.flatMap((c) => c.replacements.flatMap((r) => r.observationIds)))
  const relevant = observations.filter((o) => backing.has(o.id) && o.newNorm)
  const reverted = new Set<string>()
  if (relevant.length > 0) {
    const cellPairs = [...new Map(relevant.map((o) => [o.cellKey, o])).values()]
    const tuple = cellPairs.map(() => "(?, ?)").join(", ")
    const { results } = await db
      .prepare(
        `SELECT file_id, cell_id, value FROM cells
          WHERE project_id = ? AND side = 'target'
            AND lane_id = (SELECT id FROM public.lanes WHERE project_id = cells.project_id AND role = 'target' AND legacy_tag = ?)
            AND (file_id, cell_id) IN (${tuple})`,
      )
      .bind(projectId, lane, ...cellPairs.flatMap((o) => o.cellKey.split(CELL_KEY_SEP).slice(0, 2)))
      .all<{ file_id: string; cell_id: string; value: string }>()
    const current = new Map(
      results.map((r) => [cellKeyOf(r.file_id, r.cell_id, lane), ` ${tokenize(r.value).map((t) => t.norm).join(" ")} `]),
    )
    for (const o of relevant) {
      const now = current.get(o.cellKey)
      if (now !== undefined && !now.includes(` ${o.newNorm} `)) reverted.add(o.id)
    }
  }

  // Dismissals — counter-evidence for an (old → new) edit in this lane.
  const olds = [...new Set(candidates.map((c) => c.oldNorm))]
  const dismissals = new Map<string, number>()
  if (olds.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT old_norm, new_norm, COUNT(*)::int AS n FROM smart_edit_feedback
          WHERE project_id = ? AND lane = ? AND action = 'dismiss' AND old_norm IN (${olds.map(() => "?").join(",")})
          GROUP BY old_norm, new_norm`,
      )
      .bind(projectId, lane, ...olds)
      .all<{ old_norm: string; new_norm: string; n: number }>()
    for (const r of results) dismissals.set(dismissKey(r.old_norm, r.new_norm), Number(r.n))
  }

  return { keeps, reverted, dismissals }
}
