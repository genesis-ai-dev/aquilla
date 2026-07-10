/**
 * Post-edit magnitude metrics for AQU-311.
 *
 * Derives "how much do humans edit AI drafts?" from the event log.
 *
 * DATA PATH
 * ---------
 * Source: `target.cell.commit` events fetched via the existing
 * GET /api/v1/projects/:projectId/files/:fileId/cells/:cellId/history
 * endpoint (or the file-level /events endpoint filtered to this kind).
 *
 * Algorithm (derive on read, no new materialized columns):
 *   1. Walk a cell's commit chain (ordered by server_seq ASC = oldest first).
 *   2. Identify "AI commits": target.cell.commit with payload.ai_suggestion=true.
 *   3. For each AI commit, find the next human commit on the same chain
 *      (the first subsequent commit without ai_suggestion).
 *   4. Compute normalizedEditDistance(aiValue, humanValue).
 *   5. Tag the pair with the human commit's timestamp and author.
 *
 * APPROXIMATION / LIMITATIONS (honest docs per task spec)
 * --------------------------------------------------------
 * - "Next human commit" assumes human edits immediately follow the AI draft.
 *   In practice a second AI re-draft could intervene; we skip those and keep
 *   looking for the first human commit. If no human commit follows, the pair
 *   is excluded (still-unedited AI drafts do not contribute to post-edit distance).
 * - Character-level NED is used, not word-level TER. See edit-distance.ts.
 * - We fetch up to MAX_EVENTS_PER_FILE events per file; cells with very long
 *   revision histories may be truncated (the server caps at 200 per cell).
 * - Historical events before AQU-292 (ai_suggestion field) lack provenance;
 *   they are treated as human commits (forward-only honesty per AQU-292 spec).
 *
 * SWARM-TODO(fro-311-server-route): for large projects (> 40 files, > 200 events/cell)
 *   a dedicated read route that aggregates post-edit pairs server-side would be
 *   more efficient. Shape:
 *   GET /api/v1/projects/:projectId/post-edit-metrics
 *     ?since=<epoch-ms>&until=<epoch-ms>&user=<author>
 *   Returns: { buckets: { week: string; avgNed: number; count: number; byUser: {author: string; avgNed: number; count: number}[] }[] }
 */

import { normalizedEditDistance } from "./edit-distance"

// ── Types ──────────────────────────────────────────────────────────────────

/** A single raw AI-then-human edit pair extracted from event history. */
export interface PostEditPair {
  /** Cell identifier. */
  cellId: string
  /** File identifier. */
  fileId: string
  /** The AI draft text. */
  aiValue: string
  /** The human-edited text (first human commit after the AI commit). */
  humanValue: string
  /** Normalized edit distance [0,1]. */
  ned: number
  /** Author of the human commit. */
  author: string
  /** Server timestamp (epoch ms) of the human commit. */
  humanTs: number
  /** Server timestamp of the AI commit. */
  aiTs: number
}

/** Input event shape — minimal projection of the CellHistoryEvent. */
export interface CommitEvent {
  id: string
  parentId: string | null
  kind: string
  author: string
  serverTs: number
  serverSeq: number
  payload: unknown
}

// ── Pair extraction ─────────────────────────────────────────────────────────

/**
 * Extract post-edit pairs from a single cell's commit chain.
 *
 * @param events  Raw event array for this cell (any order; will be sorted by serverSeq).
 * @param cellId  Cell identifier (for labelling pairs).
 * @param fileId  File identifier (for labelling pairs).
 */
export function extractPostEditPairs(
  events: CommitEvent[],
  cellId: string,
  fileId: string,
): PostEditPair[] {
  // Filter to target.cell.commit events only, sorted oldest first.
  const commits = events
    .filter((e) => e.kind === "target.cell.commit" || e.kind === "target.cell.create")
    .sort((a, b) => a.serverSeq - b.serverSeq)

  const pairs: PostEditPair[] = []
  let i = 0
  while (i < commits.length) {
    const ev = commits[i]
    const payload = ev.payload as { value?: string; ai_suggestion?: true } | null
    if (payload?.ai_suggestion === true) {
      const aiValue = payload.value ?? ""
      // Scan forward for the next human commit (skip consecutive AI re-drafts).
      let j = i + 1
      while (j < commits.length) {
        const next = commits[j]
        const np = next.payload as { value?: string; ai_suggestion?: true } | null
        if (!np?.ai_suggestion) {
          // Found the human edit.
          const humanValue = np?.value ?? ""
          pairs.push({
            cellId,
            fileId,
            aiValue,
            humanValue,
            ned: normalizedEditDistance(aiValue, humanValue),
            author: next.author,
            humanTs: next.serverTs,
            aiTs: ev.serverTs,
          })
          i = j // continue from the human commit
          break
        }
        j++
      }
      if (j >= commits.length) {
        // No human commit found after this AI commit — skip.
        i++
      }
    } else {
      i++
    }
  }
  return pairs
}

// ── Bucketing ───────────────────────────────────────────────────────────────

export interface WeekBucket {
  /** ISO week start date, e.g. "2024-01-01". Monday-aligned. */
  weekStart: string
  /** Average NED across all pairs in this bucket. */
  avgNed: number
  /** Number of AI-then-human edit pairs in this bucket. */
  count: number
}

export interface UserBucket {
  author: string
  avgNed: number
  count: number
}

export interface PostEditMetrics {
  /** All extracted pairs. */
  pairs: PostEditPair[]
  /** Pairs bucketed by ISO week of the human commit. */
  byWeek: WeekBucket[]
  /** Per-author summary across all time. */
  byUser: UserBucket[]
  /** Overall average NED. */
  overallAvgNed: number
  /** Total pair count. */
  totalCount: number
}

/**
 * Monday-aligned ISO week start for an epoch-ms timestamp.
 * Returns "YYYY-MM-DD" string.
 */
export function weekStart(epochMs: number): string {
  const d = new Date(epochMs)
  // getDay: 0=Sun, 1=Mon... shift so Monday=0
  const day = d.getUTCDay()
  const diffToMonday = day === 0 ? 6 : day - 1
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() - diffToMonday)
  monday.setUTCHours(0, 0, 0, 0)
  return monday.toISOString().slice(0, 10)
}

/**
 * Aggregate a flat array of post-edit pairs into weekly buckets + per-user summary.
 */
export function aggregatePostEditMetrics(pairs: PostEditPair[]): PostEditMetrics {
  if (pairs.length === 0) {
    return { pairs: [], byWeek: [], byUser: [], overallAvgNed: 0, totalCount: 0 }
  }

  // ── By week ────────────────────────────────────────────────────────────────
  const weekMap = new Map<string, { sumNed: number; count: number }>()
  for (const p of pairs) {
    const wk = weekStart(p.humanTs)
    const entry = weekMap.get(wk) ?? { sumNed: 0, count: 0 }
    entry.sumNed += p.ned
    entry.count += 1
    weekMap.set(wk, entry)
  }
  const byWeek: WeekBucket[] = Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStartStr, { sumNed, count }]) => ({
      weekStart: weekStartStr,
      avgNed: sumNed / count,
      count,
    }))

  // ── By user ────────────────────────────────────────────────────────────────
  const userMap = new Map<string, { sumNed: number; count: number }>()
  for (const p of pairs) {
    const entry = userMap.get(p.author) ?? { sumNed: 0, count: 0 }
    entry.sumNed += p.ned
    entry.count += 1
    userMap.set(p.author, entry)
  }
  const byUser: UserBucket[] = Array.from(userMap.entries())
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([author, { sumNed, count }]) => ({
      author,
      avgNed: sumNed / count,
      count,
    }))

  // ── Overall ────────────────────────────────────────────────────────────────
  const totalNed = pairs.reduce((s, p) => s + p.ned, 0)
  const overallAvgNed = totalNed / pairs.length

  return { pairs, byWeek, byUser, overallAvgNed, totalCount: pairs.length }
}
