/**
 * How a check's finding is drawn over source or target text: which findings
 * cover which characters, in what stacking order, with which underline.
 *
 * Shared by the plain-text renderer (`HighlightedText`) and the rich-text
 * source path (`rule-ranges-html.ts`), so a finding looks the same whichever
 * path a cell renders through (AQU-1757).
 *
 * The plain-text renderer also lays the AI-draft provenance wash (#946) under
 * those underlines; the rich-text path passes no health spans.
 */

import type { DraftHealthSpan } from "@/lib/completion/draft-health-spans"
import { cn } from "@/lib/utils"

export interface RangeHighlight {
  start: number
  end: number
  kind: "violation-major" | "violation-minor" | "violation-waived"
  ruleId: string
}

/** The more severe finding sits innermost, closest to the text. */
const KIND_PRECEDENCE: Record<RangeHighlight["kind"], number> = {
  "violation-major": 0,
  "violation-minor": 1,
  "violation-waived": 2,
}

/** One underline offset per stacked finding, innermost (most severe) first.
 *  Two checks covering the same words draw two wavy lines at different
 *  offsets instead of the outer one hiding the inner (AQU-1633). Stacks
 *  deeper than this reuse the outermost offset. */
const UNDERLINE_OFFSET_CLASSES = [
  "underline-offset-[3px]",
  "underline-offset-[6px]",
  "underline-offset-[9px]",
]

/** A run of text with every range that covers it, most severe LAST (the
 *  innermost span). An empty `ranges` is plain text. `health` is the
 *  provenance wash under those underlines, when one covers the run. */
export interface DisplayChunk {
  text: string
  start: number
  ranges: RangeHighlight[]
  health?: HealthDisplaySpan
}

export type HealthDisplaySpan = DraftHealthSpan & { title?: string }

/** The classes for one finding's span; `depth` 0 is the innermost. */
export function rangeSpanClass(range: RangeHighlight, depth: number): string {
  return cn(
    range.ruleId.startsWith("term:") && "terminology-highlight",
    "decoration-wavy underline",
    UNDERLINE_OFFSET_CLASSES[Math.min(depth, UNDERLINE_OFFSET_CLASSES.length - 1)],
    range.kind === "violation-major" && "decoration-red-500",
    range.kind === "violation-minor" && "decoration-amber-500",
    range.kind === "violation-waived" && "decoration-muted-foreground/60 opacity-60",
  )
}

/** Splits the text at every violation and health-span boundary and hands each
 *  run the full set of ranges covering it, plus the health wash under it.
 *  Ranges from different rules can overlap, and one can sit wholly inside
 *  another (EditorTable concatenates spans from every rule without merging) —
 *  every character is emitted exactly once and no finding is dropped
 *  (AQU-1633). */
export function buildDisplayChunks(
  text: string,
  ranges: RangeHighlight[],
  healthSpans: HealthDisplaySpan[] = [],
): DisplayChunk[] {
  const normalized = normalizeDisplayRanges(text, ranges)
  const health = normalizeHealthSpans(text, healthSpans)
  if (normalized.length === 0 && health.length === 0) return [{ text, start: 0, ranges: [] }]

  const cuts = new Set<number>([0, text.length])
  for (const range of normalized) { cuts.add(range.start); cuts.add(range.end) }
  for (const span of health) { cuts.add(span.start); cuts.add(span.end) }
  const offsets = [...cuts].sort((a, b) => a - b)

  const chunks: DisplayChunk[] = []
  for (let i = 0; i + 1 < offsets.length; i++) {
    const start = offsets[i]
    const end = offsets[i + 1]
    if (end <= start) continue
    const covering = normalized.filter((range) => range.start <= start && range.end >= end)
    chunks.push({
      text: text.slice(start, end),
      start,
      ranges: stackOrder(covering),
      health: health.find((span) => span.start <= start && start < span.end),
    })
  }
  return chunks
}

/** Outermost first: least severe outside, most severe innermost. One span per
 *  rule — the same rule reported twice over a run underlines it once. */
function stackOrder(covering: RangeHighlight[]): RangeHighlight[] {
  const byRule = new Map<string, RangeHighlight>()
  for (const range of covering) {
    const seen = byRule.get(range.ruleId)
    if (!seen || KIND_PRECEDENCE[range.kind] < KIND_PRECEDENCE[seen.kind]) byRule.set(range.ruleId, range)
  }
  return [...byRule.values()].sort(
    (a, b) =>
      KIND_PRECEDENCE[b.kind] - KIND_PRECEDENCE[a.kind] ||
      a.ruleId.localeCompare(b.ruleId),
  )
}

function normalizeHealthSpans(text: string, spans: HealthDisplaySpan[]): HealthDisplaySpan[] {
  const length = text.length
  const out: HealthDisplaySpan[] = []
  for (const span of spans) {
    const start = Math.max(0, Math.min(length, span.start))
    const end = Math.max(0, Math.min(length, span.end))
    if (start >= end) continue
    out.push({ ...span, start, end })
  }
  out.sort((a, b) => a.start - b.start || b.end - a.end)
  return out
}

function normalizeDisplayRanges(text: string, ranges: RangeHighlight[]): RangeHighlight[] {
  const length = text.length
  const out: RangeHighlight[] = []
  for (const range of ranges) {
    const start = Math.max(0, Math.min(length, range.start))
    const end = Math.max(0, Math.min(length, range.end))
    if (start >= end) continue
    out.push({ ...range, start, end })
  }
  return out
}
