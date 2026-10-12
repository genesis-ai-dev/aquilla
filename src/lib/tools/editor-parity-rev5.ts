/**
 * Smart Extensions, apiRev 5: the host-side derivations that keep the
 * extension editor at parity with what dev's built-in editor gained after
 * apiRev 4. Each is the built-in's OWN rule, called with the same inputs, so
 * the two editors cannot disagree about what a cell shows:
 *
 * - the AI-draft provenance wash (#946) — EditorTable's healthDisplaySpans;
 * - "Not yet validated" low-confidence attention (AQU-757) — cellNeedsAttention;
 * - focus locks on the ACTIVE lane only (AQU-1808) — lockHolderForCell;
 * - the localized check name in an integrity explanation (AQU-757).
 */

import type { TFunction } from "@/lib/i18n/I18nProvider"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import type { TranslationRule } from "@/lib/parsers/types"
import {
  buildDraftHealthSpans,
  clipDraftHealthExcerpt,
  resolveDraftHealthExamples,
  type DraftHealthExample,
} from "@/lib/completion/draft-health-spans"
import { needsAttentionFromConfidence } from "@/lib/health/decay-engine"
import type { HealthRibbonPoint } from "@/lib/health/health-ribbon"
import { focusLockKey } from "@/hooks/useFocusLock"
import type { ToolHealthSpan } from "../../../shared/tools/editor-api"

export interface HealthSpanCell {
  translated: string
  aiDrafted?: boolean
  aiDraft?: { exampleIds?: string[]; exampleTexts?: { cellId: string; source: string; target: string }[] } | null
}

/** EditorTable's wash for one cell: null when the reader's "Highlight
 *  validated vs guessed words" setting is off or the cell is not AI-drafted. */
export function healthSpansForCell(opts: {
  enabled: boolean
  cell: HealthSpanCell
  /** The live draft while editing; default the committed translation. */
  text?: string
  /** useCompletion's in-memory examples for the cell (ScoredPair-shaped). */
  live?: readonly { cellId: string; source: string; target: string }[] | null
  lookup?: (cellId: string) => { source: string; target: string } | undefined
  t: TFunction
}): ToolHealthSpan[] | null {
  const { enabled, cell, t } = opts
  if (!enabled || !cell.aiDrafted) return null
  const draft = opts.text ?? cell.translated
  if (!draft?.trim()) return null
  const examples: DraftHealthExample[] = resolveDraftHealthExamples({
    live: opts.live,
    persisted: cell.aiDraft?.exampleTexts,
    exampleIds: cell.aiDraft?.exampleIds,
    lookup: opts.lookup,
  })
  return buildDraftHealthSpans(draft, examples).map((span) => ({
    start: span.start,
    end: span.end,
    kind: span.kind,
    ...(span.kind === "supported" && span.exampleSource != null && span.exampleTarget != null
      ? { title: t("editor.health.citedExample", { source: clipDraftHealthExcerpt(span.exampleSource), target: clipDraftHealthExcerpt(span.exampleTarget) }) }
      : {}),
  }))
}

/** EditorTable's cellNeedsAttention: text, the automatic stage, a smoothed
 *  score, and that score's decay past the project's warn threshold. */
export function ribbonNeedsAttention(point: HealthRibbonPoint, hasContent: boolean, decayWarnThreshold: number | undefined): boolean {
  return hasContent
    && point.stage === "automatic"
    && point.smoothedScore !== undefined
    && needsAttentionFromConfidence(point.smoothedScore, decayWarnThreshold)
}

/** The leases held on `lane`, keyed by bare cell id — what an editor pointed
 *  at that lane should show as "X is editing" (AQU-1808: a lease is stored as
 *  `cellId@lane:<tag>`; the bare id is the default lane's key, so another
 *  lane's lease never locks this one). */
export function lockHoldersOnLane(holders: ReadonlyMap<string, string> | null | undefined, lane: string, cellIds?: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>()
  if (!holders) return out
  if (cellIds) {
    for (const cellId of cellIds) {
      const holder = holders.get(focusLockKey(cellId, lane))
      if (holder) out.set(cellId, holder)
    }
    return out
  }
  for (const [key, username] of holders) {
    const at = key.indexOf("@lane:")
    const cellId = at === -1 ? key : key.slice(0, at)
    const keyLane = at === -1 ? "" : key.slice(at + "@lane:".length)
    if (keyLane === lane) out.set(cellId, username)
  }
  return out
}

/** The check's name as the built-in's hover names it (AQU-757). */
export function issueRuleName(rule: TranslationRule | undefined, ruleId: string, t: TFunction): string {
  return rule ? translateRuleName(rule, t) : ruleId
}
