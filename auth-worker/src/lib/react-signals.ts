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
import { REACT_SAMPLE_CELLS, REACT_SAMPLE_CHARS, type EditSample } from "./react-route"

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
  id: string
  kind: string
  file_id: string
  /** Lane legacy tag from the event payload ('' = default lane, AQU-538).
   *  Events still carry the tag; AQU-1612 puts the id on the event itself. */
  target_lang: string
  /** The lane that tag resolves to, `null` when it names no lane (AQU-1610). */
  lane_id: string | null
  cell_id: string | null
  canonical_ref: string | null
  server_ts: number | string
}

export interface FileSignal {
  fileId: string
  /** The lane the human was editing — the reaction drafts in that lane, never
   *  the default one by accident (AQU-1447 made the agent lane-scoped).
   *  `lanes.id`, resolved from the event's tag (AQU-1610); `null` when the tag
   *  names no lane, which keys the signal apart from every real lane. */
  laneId: string | null
  /** The same lane's legacy tag, passed on to callers that still take one. */
  targetLang: string
  count: number
  /** Most recently touched cell — where the human was working, and so where
   *  the reaction run anchors its first wave. */
  anchorCellId: string | null
  /** Canonical refs (falling back to cell ids) for the direction text. */
  refs: string[]
  latestTs: number
  /** Most recent text commits (oldest first, capped) — what Jev reads as the
   *  before → after sample. Empty when the signal is validations only. */
  commitEventIds: string[]
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
      // AQU-1610: the payload tag is resolved to its lane id here, so the
      // signal and the run-state map below key on the same lane identity.
      // The source join drops `target_lang = ''` — a source row is
      // `side = 'source'`, whatever lane it sits in.
      `SELECT e.id, e.kind, e.file_id, COALESCE(e.payload::jsonb ->> 'targetLang', '') AS target_lang,
              ln.id AS lane_id,
              e.cell_id, c.canonical_ref, e.server_ts
         FROM events e
         LEFT JOIN cells c
           ON c.project_id = e.project_id AND c.file_id = e.file_id
          AND c.cell_id = e.cell_id AND c.side = 'source'
         LEFT JOIN lanes ln
           ON ln.project_id = e.project_id AND ln.role = 'target'
          AND ln.legacy_tag = COALESCE(e.payload::jsonb ->> 'targetLang', '')
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

/** Collapse a window of events into one signal per (file, lane), freshest
 *  first — the bounded per-sweep batch should spend itself on the newest
 *  signal. Edits in two lanes of one file are two signals. */
export function groupByFile(rows: ExpertEventRow[]): FileSignal[] {
  const byFile = new Map<string, FileSignal>()
  for (const row of rows) {
    const key = fileLaneKey(row.file_id, row.lane_id)
    const signal = byFile.get(key) ?? {
      fileId: row.file_id,
      laneId: row.lane_id,
      targetLang: row.target_lang,
      count: 0,
      anchorCellId: null,
      refs: [],
      latestTs: 0,
      commitEventIds: [] as string[],
    }
    signal.count += 1
    // Rows arrive oldest-first, so the last write wins: the anchor ends up on
    // the most recently edited cell.
    if (row.cell_id) signal.anchorCellId = row.cell_id
    const ref = row.canonical_ref ?? row.cell_id
    if (ref && !signal.refs.includes(ref)) signal.refs.push(ref)
    signal.latestTs = Math.max(signal.latestTs, Number(row.server_ts))
    if (row.kind === "target.cell.commit") {
      signal.commitEventIds.push(row.id)
      if (signal.commitEventIds.length > REACT_SAMPLE_CELLS) signal.commitEventIds.shift()
    }
    byFile.set(key, signal)
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
/** What a (file, lane)'s most-relevant undead run means for a reaction:
 *  `busy` — actively working, leave it alone; `paused` — a PERSON paused it,
 *  never override that intent; `parked` — idle, carrying dev's park reason
 *  (AQU-1300): `awaiting_input` is woken with a budget grant, `work_exhausted`
 *  is retired and replaced by a fresh run over the file's current state. */
export type FileRunState =
  | { state: "busy" }
  | { state: "paused" }
  | { state: "parked"; runId: string; parkReason: "awaiting_input" | "work_exhausted" | null }

/** Key for run states and signals: dev's one-active-run guard is per
 *  (file, lane), so a reaction must never wake or wait on another lane's run.
 *  Keyed on `lanes.id` since AQU-1610 — a tag can name two lanes, and then one
 *  lane's reaction waits on the other lane's run. A `null` lane id (a tag that
 *  resolves to no lane) gets its own key rather than joining the real ones. */
export function fileLaneKey(fileId: string, laneId: string | null): string {
  return `${fileId}\u0000${laneId ?? "\u0001none"}`
}

export async function readRunStatesByFile(
  db: AquillaDb,
  projectId: string,
): Promise<Map<string, FileRunState>> {
  const { results } = await db
    .prepare(
      `SELECT file_id, lane_id, id, status, park_reason FROM contextual_runs
        WHERE project_id = ?
          AND status IN ('running','pausing','paused','parked','waiting')
        ORDER BY updated_at DESC`,
    )
    .bind(projectId)
    .all<{ file_id: string; lane_id: string | null; id: string; status: string; park_reason: string | null }>()
  const rank = (state: FileRunState["state"]): number =>
    state === "busy" ? 2 : state === "paused" ? 1 : 0
  const map = new Map<string, FileRunState>()
  for (const row of results) {
    const next: FileRunState =
      row.status === "paused"
        ? { state: "paused" }
        : row.status === "parked"
          ? {
              state: "parked",
              runId: row.id,
              parkReason:
                row.park_reason === "awaiting_input" || row.park_reason === "work_exhausted"
                  ? row.park_reason
                  : null,
            }
          : { state: "busy" }
    const key = fileLaneKey(row.file_id, row.lane_id)
    const current = map.get(key)
    // Rows arrive newest-first, so on equal rank the FRESHEST run wins (a
    // reaction wakes the most recently parked run, not an ancient one).
    if (!current || rank(next.state) > rank(current.state)) map.set(key, next)
  }
  return map
}

/**
 * The before → after texts Jev reads for one signal, in the order given. The
 * "before" is the parent event's text (the prior winning commit on that cell);
 * a first-ever commit has none. Source text is the shared source row. Texts are
 * cut to REACT_SAMPLE_CHARS here so no caller can send a whole chapter.
 */
export async function readEditSamples(
  db: AquillaDb,
  projectId: string,
  eventIds: string[],
): Promise<EditSample[]> {
  if (eventIds.length === 0) return []
  const placeholders = eventIds.map(() => "?").join(",")
  const { results } = await db
    .prepare(
      `SELECT e.id,
              COALESCE(e.payload::jsonb ->> 'value', '') AS after,
              COALESCE(p.payload::jsonb ->> 'value', '') AS before,
              COALESCE(src.value, '') AS source,
              src.canonical_ref
         FROM events e
         LEFT JOIN events p ON p.id = e.parent_id AND p.project_id = e.project_id
         LEFT JOIN cells src
           ON src.project_id = e.project_id AND src.file_id = e.file_id
          AND src.cell_id = e.cell_id AND src.side = 'source'
        WHERE e.project_id = ? AND e.id IN (${placeholders})`,
    )
    .bind(projectId, ...eventIds)
    .all<{ id: string; after: string; before: string; source: string; canonical_ref: string | null }>()
  const byId = new Map(results.map((r) => [r.id, r]))
  const cut = (t: string) => (t.length > REACT_SAMPLE_CHARS ? `${t.slice(0, REACT_SAMPLE_CHARS - 1)}…` : t)
  return eventIds.flatMap((id) => {
    const r = byId.get(id)
    return r ? [{ ref: r.canonical_ref, source: cut(r.source), before: cut(r.before), after: cut(r.after) }] : []
  })
}
