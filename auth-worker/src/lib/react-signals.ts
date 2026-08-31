/**
 * react-signals.ts — what the event log says, for the v3 react watcher
 * (docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md §v3).
 *
 * Reading half of the loop: turn a window of the append-only `events` table
 * into per-file signals, plus the two cheap lookups the gates need. Kept apart
 * from lib/react-loop.ts, which owns the DECISION (debounce, cooldown, one open
 * reaction per file) and the cursor — so the "what happened" queries can be
 * read, and changed, without re-reading the policy they feed.
 */

import type { AquillaDb } from "../../../db/shim/postgres"

/** Expert input the watcher reacts to: a human committing a translation, or a
 *  human validating one. Everything else in the log (source imports, audio,
 *  reorders, deletes) is not a judgement about the target text. */
export const HUMAN_EXPERT_EVENT_KINDS = ["target.cell.commit", "cell.validate"] as const

/** Key/value catalogs have no discourse to construe — mirrors
 *  NON_DISCOURSE_KINDS in db/shared/contextual-runs.ts, which the project-wide
 *  autopilot fan-out uses for the same judgement. */
export const NON_DISCOURSE_KINDS = new Set(["json", "po", "properties", "idml"])

/** Rows one sweep will read out of the events log for one project. */
export const REACT_MAX_EVENTS_PER_SWEEP = 2000

export interface ExpertEventRow {
  file_id: string
  cell_id: string | null
  canonical_ref: string | null
  server_ts: number | string
}

export interface FileSignal {
  fileId: string
  count: number
  /** Most recently touched cell — where the human was working, and so where
   *  the reaction run anchors its first wave. */
  anchorCellId: string | null
  /** Canonical refs (falling back to cell ids) for the direction text. */
  refs: string[]
  latestTs: number
}

/**
 * Human expert input in `(cursor, windowEnd]`, oldest first.
 *
 * Two exclusions make "human" mean human:
 *   • `provenance ->> 'origin' = 'agent'` — the external Agent API stamps this
 *     on every event it commits through the approval gate (sync-worker
 *     external/commit-gates.ts).
 *   • `payload ->> 'agent_run_id'` — the in-app agent's apply path tags the
 *     commits it writes (see countByProvenance in lib/agent/runs.ts).
 * Without them a reaction could react to the previous reaction's own output,
 * which is a loop that spends real money.
 */
export async function readExpertEvents(
  db: AquillaDb,
  projectId: string,
  cursor: number,
  windowEnd: number,
): Promise<ExpertEventRow[]> {
  const kindPlaceholders = HUMAN_EXPERT_EVENT_KINDS.map(() => "?").join(",")
  const { results } = await db
    .prepare(
      `SELECT e.file_id, e.cell_id, c.canonical_ref, e.server_ts
         FROM events e
         LEFT JOIN cells c
           ON c.project_id = e.project_id AND c.file_id = e.file_id
          AND c.cell_id = e.cell_id AND c.side = 'source' AND c.target_lang = ''
        WHERE e.project_id = ?
          AND e.kind IN (${kindPlaceholders})
          AND e.file_id IS NOT NULL
          AND e.server_ts > ? AND e.server_ts <= ?
          AND (e.provenance IS NULL OR e.provenance ->> 'origin' <> 'agent')
          AND e.payload::jsonb ->> 'agent_run_id' IS NULL
        ORDER BY e.server_ts ASC
        LIMIT ?`,
    )
    .bind(projectId, ...HUMAN_EXPERT_EVENT_KINDS, cursor, windowEnd, REACT_MAX_EVENTS_PER_SWEEP)
    .all<ExpertEventRow>()
  return results
}

/** Collapse a window of events into one signal per file, freshest file first —
 *  the bounded per-sweep batch should spend itself on the newest signal. */
export function groupByFile(rows: ExpertEventRow[]): FileSignal[] {
  const byFile = new Map<string, FileSignal>()
  for (const row of rows) {
    const signal = byFile.get(row.file_id) ?? {
      fileId: row.file_id,
      count: 0,
      anchorCellId: null,
      refs: [],
      latestTs: 0,
    }
    signal.count += 1
    // Rows arrive oldest-first, so the last write wins: the anchor ends up on
    // the most recently edited cell.
    if (row.cell_id) signal.anchorCellId = row.cell_id
    const ref = row.canonical_ref ?? row.cell_id
    if (ref && !signal.refs.includes(ref)) signal.refs.push(ref)
    signal.latestTs = Math.max(signal.latestTs, Number(row.server_ts))
    byFile.set(row.file_id, signal)
  }
  return [...byFile.values()].sort((a, b) => b.latestTs - a.latestTs)
}

/** File kinds, for the discourse gate. One query for the whole batch; a file
 *  missing from the result is deleted or gone, which is itself a skip. */
export async function readFileKinds(
  db: AquillaDb,
  projectId: string,
  fileIds: string[],
): Promise<Map<string, string>> {
  if (fileIds.length === 0) return new Map()
  const placeholders = fileIds.map(() => "?").join(",")
  const { results } = await db
    .prepare(
      `SELECT id, COALESCE(kind, '') AS kind FROM files
        WHERE project_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
    .bind(projectId, ...fileIds)
    .all<{ id: string; kind: string }>()
  return new Map(results.map((row) => [row.id, row.kind]))
}

/** Files with a run already in flight — the reaction is already happening. */
/** What a file's most-relevant undead run means for a reaction:
 *  `busy` — actively working, leave it alone; `paused` — a PERSON paused it,
 *  never override that intent; `parked` — idle but resumable, so a reaction
 *  WAKES it (carrying the run id to wake) instead of starting a rival run. */
export type FileRunState =
  | { state: "busy" }
  | { state: "paused" }
  | { state: "parked"; runId: string }

export async function readRunStatesByFile(
  db: AquillaDb,
  projectId: string,
): Promise<Map<string, FileRunState>> {
  const { results } = await db
    .prepare(
      `SELECT file_id, id, status FROM contextual_runs
        WHERE project_id = ?
          AND status IN ('running','pausing','paused','parked','waiting')
        ORDER BY updated_at DESC`,
    )
    .bind(projectId)
    .all<{ file_id: string; id: string; status: string }>()
  const rank = (state: FileRunState["state"]): number =>
    state === "busy" ? 2 : state === "paused" ? 1 : 0
  const map = new Map<string, FileRunState>()
  for (const row of results) {
    const next: FileRunState =
      row.status === "paused"
        ? { state: "paused" }
        : row.status === "parked"
          ? { state: "parked", runId: row.id }
          : { state: "busy" }
    const current = map.get(row.file_id)
    // Rows arrive newest-first, so on equal rank the FRESHEST run wins (a
    // reaction wakes the most recently parked run, not an ancient one).
    if (!current || rank(next.state) > rank(current.state)) map.set(row.file_id, next)
  }
  return map
}
