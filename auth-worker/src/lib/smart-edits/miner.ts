/**
 * smart-edits/miner.ts — fold new target.cell.commit events into the project's
 * edit memory (smart_edit_observations, migration 0130).
 *
 * Incremental and idempotent. Each pass reads commits in (mined_through,
 * now - SETTLE_WINDOW_MS], fetches the whole commit chain of every cell they
 * touch (the "before" of an edit can be older than the window), runs the shared
 * settle + diff logic from src/lib/smart-edits, and inserts one row per edit op
 * with ON CONFLICT DO NOTHING. Two passes racing on one project do the same
 * work twice and write nothing twice.
 *
 * Commits younger than the settle window are never read: a person still typing
 * has not finished the edit, and mining it would teach the memory half a word.
 */

import type { AquillaDb } from "../../../../db/shim/postgres"
import {
  bulkKeyOf,
  commitOrigin,
  settledPairs,
  SETTLE_WINDOW_MS,
  type ChainEvent,
} from "../../../../src/lib/smart-edits/chains"
import { observationsFromPair } from "../../../../src/lib/smart-edits/observe"

/** Commits read per pass. A pass is one bounded unit of work in a request's
 *  waitUntil or a backfill loop. */
export const MINE_EVENTS_PER_PASS = 2000
const CELLS_PER_CHAIN_QUERY = 200
const INSERTS_PER_BATCH = 200

/** Ids may contain "/", never a control character. */
export const CELL_KEY_SEP = "\u0001"

export function cellKeyOf(fileId: string, cellId: string, lane: string): string {
  return [fileId, cellId, lane].join(CELL_KEY_SEP)
}

interface NewEventRow {
  file_id: string
  cell_id: string
  server_ts: number
}

interface ChainRow {
  id: string
  parent_id: string | null
  author: string
  server_ts: number
  file_id: string
  cell_id: string
  lane: string
  value: string | null
  ai_suggestion: string | null
  agent_run_id: string | null
  propagated_from_cell_id: string | null
  harmonize_origin: string | null
  smart_edit_id: string | null
  search_query: string | null
  replace_string: string | null
  prov_origin: string | null
}

export interface MineResult {
  events: number
  observations: number
  minedThrough: number
  /** True when the pass stopped at its event cap — call again to continue. */
  more: boolean
}

export async function minePass(db: AquillaDb, projectId: string, now = Date.now()): Promise<MineResult> {
  const state = await db
    .prepare("SELECT mined_through FROM smart_edit_state WHERE project_id = ?")
    .bind(projectId)
    .first<{ mined_through: number }>()
  const from = Number(state?.mined_through ?? 0)
  let upper = now - SETTLE_WINDOW_MS
  if (upper <= from) return { events: 0, observations: 0, minedThrough: from, more: false }

  const { results: fresh } = await db
    .prepare(
      `SELECT file_id, cell_id, server_ts FROM events
        WHERE project_id = ? AND server_ts > ? AND server_ts <= ?
          AND kind = 'target.cell.commit' AND file_id IS NOT NULL AND cell_id IS NOT NULL
        ORDER BY server_ts ASC LIMIT ?`,
    )
    .bind(projectId, from, upper, MINE_EVENTS_PER_PASS + 1)
    .all<NewEventRow>()

  let rows = fresh
  let more = false
  if (fresh.length > MINE_EVENTS_PER_PASS) {
    // Stop strictly before the last timestamp read, so events sharing it are
    // all picked up together next pass rather than split across the cap.
    more = true
    const lastTs = Number(fresh[MINE_EVENTS_PER_PASS].server_ts)
    rows = fresh.filter((r) => Number(r.server_ts) < lastTs)
    if (rows.length === 0) rows = fresh.slice(0, MINE_EVENTS_PER_PASS)
    upper = Number(rows[rows.length - 1].server_ts)
  }

  const cells = [...new Map(rows.map((r) => [`${r.file_id}\u0000${r.cell_id}`, r])).values()]
  let observations = 0
  for (let i = 0; i < cells.length; i += CELLS_PER_CHAIN_QUERY) {
    const slice = cells.slice(i, i + CELLS_PER_CHAIN_QUERY)
    observations += await mineCells(db, projectId, slice, from, upper, now)
  }

  await db
    .prepare(
      `INSERT INTO smart_edit_state (project_id, mined_through, updated_at) VALUES (?, ?, clock_timestamp())
       ON CONFLICT (project_id) DO UPDATE
         SET mined_through = GREATEST(smart_edit_state.mined_through, EXCLUDED.mined_through),
             updated_at = clock_timestamp()`,
    )
    .bind(projectId, upper)
    .run()

  return { events: rows.length, observations, minedThrough: upper, more }
}

async function mineCells(
  db: AquillaDb,
  projectId: string,
  cells: readonly NewEventRow[],
  from: number,
  upper: number,
  now: number,
): Promise<number> {
  const tuple = cells.map(() => "(?, ?)").join(", ")
  const pairsArgs = cells.flatMap((c) => [c.file_id, c.cell_id])
  const { results: chain } = await db
    .prepare(
      `SELECT e.id, e.parent_id, e.author, e.server_ts, e.file_id, e.cell_id,
              COALESCE(p ->> 'targetLang', '') AS lane,
              p ->> 'value' AS value,
              p ->> 'ai_suggestion' AS ai_suggestion,
              p ->> 'agent_run_id' AS agent_run_id,
              p ->> 'propagated_from_cell_id' AS propagated_from_cell_id,
              p ->> 'harmonize_origin' AS harmonize_origin,
              p ->> 'smart_edit_id' AS smart_edit_id,
              p ->> 'search_query' AS search_query,
              p ->> 'replace_string' AS replace_string,
              e.provenance ->> 'origin' AS prov_origin
         FROM events e, LATERAL (SELECT e.payload::jsonb AS p) j
        WHERE e.project_id = ? AND e.kind = 'target.cell.commit'
          AND (e.file_id, e.cell_id) IN (${tuple})`,
    )
    .bind(projectId, ...pairsArgs)
    .all<ChainRow>()

  const { results: sources } = await db
    .prepare(
      `SELECT file_id, cell_id, value FROM cells
        WHERE project_id = ? AND side = 'source'
          AND (file_id, cell_id) IN (${tuple})`,
    )
    .bind(projectId, ...pairsArgs)
    .all<{ file_id: string; cell_id: string; value: string }>()
  const sourceOf = new Map(sources.map((s) => [`${s.file_id}\u0000${s.cell_id}`, s.value]))

  const groups = new Map<string, { fileId: string; cellId: string; lane: string; events: ChainEvent[] }>()
  for (const r of chain) {
    const key = cellKeyOf(r.file_id, r.cell_id, r.lane)
    const payload: Record<string, unknown> = {
      ai_suggestion: r.ai_suggestion === "true" ? true : undefined,
      agent_run_id: r.agent_run_id ?? undefined,
      propagated_from_cell_id: r.propagated_from_cell_id ?? undefined,
      harmonize_origin: r.harmonize_origin ?? undefined,
      smart_edit_id: r.smart_edit_id ?? undefined,
      search_query: r.search_query ?? undefined,
      replace_string: r.replace_string ?? undefined,
    }
    const ev: ChainEvent = {
      id: r.id,
      parentId: r.parent_id,
      author: r.author,
      ts: Number(r.server_ts),
      value: r.value ?? "",
      origin: commitOrigin(payload, r.prov_origin),
      bulkKey: bulkKeyOf(payload),
    }
    const g = groups.get(key)
    if (g) g.events.push(ev)
    else groups.set(key, { fileId: r.file_id, cellId: r.cell_id, lane: r.lane, events: [ev] })
  }

  const stmts = []
  let count = 0
  for (const [cellKey, g] of groups) {
    const source = sourceOf.get(`${g.fileId}\u0000${g.cellId}`) ?? ""
    for (const pair of settledPairs(g.events, now, from)) {
      if (pair.ts > upper) continue
      for (const o of observationsFromPair(pair, cellKey, source)) {
        count++
        stmts.push(
          db
            .prepare(
              `INSERT INTO smart_edit_observations
                 (project_id, id, lane, file_id, cell_id, after_event_id, before_event_id, author, ts,
                  before_origin, bulk_key, old, old_norm, new, new_norm, left_ctx, right_ctx,
                  source_norms, source_text, before_text, after_text)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (project_id, id) DO NOTHING`,
            )
            .bind(
              projectId, o.id, g.lane, g.fileId, g.cellId, pair.afterId, pair.beforeId, pair.author, pair.ts,
              o.beforeOrigin, o.bulkKey, o.old, o.oldNorm, o.new, o.newNorm,
              JSON.stringify(o.left), JSON.stringify(o.right), JSON.stringify(o.sourceNorms),
              o.sourceText, o.beforeText, o.afterText,
            ),
        )
      }
    }
  }
  for (let i = 0; i < stmts.length; i += INSERTS_PER_BATCH) await db.batch(stmts.slice(i, i + INSERTS_PER_BATCH))
  return count
}
