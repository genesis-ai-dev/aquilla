/**
 * Per-cell post-editing distance for the Edit History drawer (AQU-1321).
 *
 * `post-edit-metrics.ts` answers the project-level question straight from the
 * event log, and it requires a `cell.validate` event before a draft counts: a
 * project average must not treat an abandoned edit as finished work. The drawer
 * asks a narrower question about two cards the reader is already looking at —
 * "how much of that draft survived into the revision under it?" — so it works
 * off `CellHistoryEntry`, which carries no validation event ids, and reads a
 * draft against the human revision that followed it whether or not anyone has
 * approved that revision yet. The two numbers can legitimately disagree while
 * an edit is unapproved; the project panel is the one that gates on approval,
 * and this one is the one that explains a single cell.
 *
 * Two rules keep the number honest about what the drawer is showing:
 *
 * - **Off-chain entries are skipped.** An entry flagged `isStale` lost the AD-2
 *   first-child-of-parent race and never became the cell's value, and a
 *   `failed` entry never reached the server. The drawer says so on the card, so
 *   measuring a draft against one would describe an edit the reader is
 *   simultaneously being told did not apply.
 * - **A draft is read against the *last* human revision in the run that
 *   follows it**, not the first. The drawer collapses a run of keystroke-level
 *   edits into one card and renders only that group's terminal entry, so a
 *   reading attached to the first keystroke would be invisible — and "how much
 *   of the draft survived" is a question about where the human ended up
 *   anyway, not about their first stroke.
 */

import type { CellHistoryEntry } from "@/lib/parsers/types"
import { normalizedEditDistance } from "./edit-distance"

export interface HistoryPostEdit {
  /** Share of the AI draft that survived into the human revision, in [0, 1]. */
  keptFraction: number
  /** Character-level normalized edit distance — always `1 - keptFraction`. */
  ned: number
  /** Index in the history array of the draft this reading is measured against. */
  draftIndex: number
  /** The draft became the cell's approved value with no edit at all. */
  acceptedAsIs: boolean
}

/** An entry the cell's chain never adopted, so nothing should be measured to it. */
function isOffChain(entry: CellHistoryEntry): boolean {
  return entry.isStale === true || entry.syncState === "failed"
}

/**
 * Positional companion to `history`: `series[i]` is the reading to show on
 * entry `i`, or `null` when that entry has nothing to measure — the cell was
 * written by hand from the start, or the entry is an intermediate keystroke.
 *
 * Positional rather than keyed by `eventId` because legacy Y.Doc-derived
 * entries have no event id at all and two of them can share a timestamp, so
 * there is no key that is unique across a real history.
 *
 * `history` must be in the chronological order the drawer receives it (oldest
 * first); the drawer reverses only for display.
 */
export function derivePostEditSeries(
  history: readonly CellHistoryEntry[],
): (HistoryPostEdit | null)[] {
  const series: (HistoryPostEdit | null)[] = history.map(() => null)
  let draft: { index: number; value: string; validated: boolean } | null = null

  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    if (isOffChain(entry)) continue

    if (entry.source === "llm") {
      // A re-draft supersedes the previous one. The human worked from the
      // closest draft, so that is the only one their edit can be read against.
      draft = { index: i, value: entry.value, validated: entry.validated }
      continue
    }
    if (!draft) continue

    // Walk to the end of this run of on-chain human entries — that entry is
    // the one the drawer renders for the group (see the module comment).
    let last = i
    for (let j = i + 1; j < history.length; j++) {
      const next = history[j]
      if (isOffChain(next)) continue
      if (next.source === "llm") break
      last = j
    }

    const ned = normalizedEditDistance(draft.value, history[last].value)
    series[last] = {
      keptFraction: 1 - ned,
      ned,
      draftIndex: draft.index,
      acceptedAsIs: ned === 0,
    }
    // One reading per draft: a later, separate edit is an edit of the human
    // text, not of the draft, and reporting it as draft survival would be a lie.
    draft = null
    i = last
  }

  // A draft nobody revised counts as fully kept only once it has been approved.
  // An unreviewed draft sitting at the head of the chain is not "100% kept" —
  // nobody has looked at it yet, which is a different claim entirely.
  if (draft?.validated) {
    series[draft.index] = {
      keptFraction: 1,
      ned: 0,
      draftIndex: draft.index,
      acceptedAsIs: true,
    }
  }

  return series
}
