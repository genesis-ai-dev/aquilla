/**
 * Pending human actions, grouped by passage (AQU-1301).
 *
 * A long autopilot run stages hundreds of drafts. Summing them into one number
 * tells the reviewer how far behind they are and nothing about where to start,
 * and it buries the open decision — the one item that is actually blocking the
 * run — inside the same pile. This module splits the pending set into the
 * passage the run is parked on (the actionable set) and everything else (a
 * count the reviewer can expand on demand).
 *
 * Two rules are load-bearing and are what the tests pin:
 *   1. An open decision is never collapsed. It blocks the run, so it is always
 *      reachable without expanding anything.
 *   2. The remainder is a count, never a flat list. Expanding it yields groups
 *      in passage order, not arrival order.
 */

import { humanPassageLabel } from "../../../shared/span-label"
import type { ContextualActivityDraft, ContextualDecisionView } from "./transport"

/** One passage's worth of pending work — what a reviewer can act on in one sitting. */
export interface PendingPassageGroup {
  /** Stable React key / lookup key. The span id when the backend supplied one,
   *  otherwise the passage label, otherwise a per-file bucket. */
  key: string
  /** The run's span id, when drafts carry one in provenance. */
  spanId: string | null
  /** Human passage reference (`LUK 4:1–4:12`), or null when only opaque ids exist. */
  spanLabel: string | null
  fileId: string | null
  /** Drafts staged for this passage, oldest first. */
  drafts: ContextualActivityDraft[]
  /** Open decisions raised on this passage. These lead the group — they block the run. */
  decisions: ContextualDecisionView[]
  /** Earliest draft timestamp in the group; the passage-order sort key. */
  firstStagedAt: number
}

export interface PendingActionSplit {
  /** The passage the run is parked on. Null only when nothing is pending. */
  current: PendingPassageGroup | null
  /** Everything else, in passage order. Rendered only when expanded. */
  rest: PendingPassageGroup[]
  restDraftCount: number
  restPassageCount: number
  restFileCount: number
  /** Open decisions that match no loaded passage. Shown alongside `current`
   *  rather than collapsed, because a decision is never hidden behind a count. */
  unplacedDecisions: ContextualDecisionView[]
}

const EMPTY_SPLIT: PendingActionSplit = {
  current: null,
  rest: [],
  restDraftCount: 0,
  restPassageCount: 0,
  restFileCount: 0,
  unplacedDecisions: [],
}

function draftSpanId(draft: ContextualActivityDraft): string | null {
  const provenance = draft.provenance
  if (!provenance || typeof provenance !== "object") return null
  const spanId = (provenance as { spanId?: unknown }).spanId
  return typeof spanId === "string" && spanId ? spanId : null
}

/** Epoch millis, or `Infinity` for an unparseable/absent stamp so undated
 *  drafts sort last instead of jumping to the front of the queue. */
function stagedAt(draft: ContextualActivityDraft): number {
  if (typeof draft.createdAt !== "string") return Infinity
  const ms = Date.parse(draft.createdAt)
  return Number.isNaN(ms) ? Infinity : ms
}

function groupKey(draft: ContextualActivityDraft): string {
  const spanId = draftSpanId(draft)
  if (spanId) return `span:${spanId}`
  const label = humanPassageLabel(draft.spanLabel)
  if (label) return `label:${label}`
  return `file:${draft.fileId ?? ""}`
}

/**
 * Splits proposed drafts and open decisions into the current parked passage
 * plus a collapsed remainder.
 *
 * **Passage order.** Groups are ordered by the timestamp of their earliest
 * draft. The tick walks its span cursor in index order and stages as it goes,
 * so for a single run first-staged order *is* passage order — without needing
 * the server to ship the span cursor to the client. Ties (same millisecond)
 * fall back to the group key so the order is stable across renders.
 *
 * **Which passage is current.** In precedence order:
 *   1. the passage carrying the oldest open decision — the run is stuck there;
 *   2. the passage matching `currentSpanLabel` from the live run frame;
 *   3. the last passage in passage order — where the run got to before parking.
 */
export function splitPendingActions(
  drafts: ContextualActivityDraft[],
  decisions: ContextualDecisionView[],
  currentSpanLabel: string | null = null,
): PendingActionSplit {
  const openDecisions = decisions.filter((decision) => decision.status === "open")
  if (drafts.length === 0) {
    // No drafts to group against, so every open decision is unplaced. It still
    // must not vanish: an empty draft set is exactly when the blocking question
    // is the only thing left to act on.
    return { ...EMPTY_SPLIT, unplacedDecisions: openDecisions }
  }

  const byKey = new Map<string, PendingPassageGroup>()
  for (const draft of drafts) {
    const key = groupKey(draft)
    const existing = byKey.get(key)
    const at = stagedAt(draft)
    if (existing) {
      existing.drafts.push(draft)
      if (at < existing.firstStagedAt) existing.firstStagedAt = at
      // A later draft may carry the label an earlier one lacked.
      if (!existing.spanLabel) existing.spanLabel = humanPassageLabel(draft.spanLabel)
      if (!existing.spanId) existing.spanId = draftSpanId(draft)
      continue
    }
    byKey.set(key, {
      key,
      spanId: draftSpanId(draft),
      spanLabel: humanPassageLabel(draft.spanLabel),
      fileId: draft.fileId ?? null,
      drafts: [draft],
      decisions: [],
      firstStagedAt: at,
    })
  }

  const groups = [...byKey.values()].sort((a, b) =>
    a.firstStagedAt - b.firstStagedAt || a.key.localeCompare(b.key))
  for (const group of groups) {
    group.drafts.sort((a, b) => stagedAt(a) - stagedAt(b))
  }

  // Attach each open decision to its passage. `spanId` is the exact join; a
  // decision whose span never staged a draft stays unplaced rather than being
  // filed under an unrelated passage.
  const bySpanId = new Map<string, PendingPassageGroup>()
  for (const group of groups) if (group.spanId) bySpanId.set(group.spanId, group)
  const unplacedDecisions: ContextualDecisionView[] = []
  for (const decision of openDecisions) {
    const group = decision.spanId ? bySpanId.get(decision.spanId) : undefined
    if (group) group.decisions.push(decision)
    else unplacedDecisions.push(decision)
  }

  const blocked = groups.find((group) => group.decisions.length > 0) ?? null
  const byLabel = currentSpanLabel
    ? groups.find((group) => group.spanLabel === humanPassageLabel(currentSpanLabel)) ?? null
    : null
  const current = blocked ?? byLabel ?? groups[groups.length - 1] ?? null

  const rest = groups.filter((group) => group !== current)
  const restFiles = new Set(rest.map((group) => group.fileId ?? ""))
  return {
    current,
    rest,
    restDraftCount: rest.reduce((total, group) => total + group.drafts.length, 0),
    restPassageCount: rest.length,
    restFileCount: restFiles.size,
    unplacedDecisions,
  }
}
