import { useMemo, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export const EXAMPLE_COLORS = [
  "#3b82f6", "#f97316", "#22c55e", "#a855f7",
  "#14b8a6", "#f43f5e", "#eab308", "#6366f1",
]

export interface TokenHighlight {
  token: string
  colorIndex: number
}

export interface RangeHighlight {
  start: number
  end: number
  kind: "violation-major" | "violation-minor" | "violation-waived"
  ruleId: string
  /** AQU-1740: the finding this underline covers, when it has one — lets a
   *  click on it waive that match rather than the whole rule. */
  matchHash?: string
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
 *  innermost span). An empty `ranges` is plain text. */
interface DisplayChunk {
  text: string
  start: number
  ranges: RangeHighlight[]
}

interface HighlightedTextProps {
  text: string
  /** Token-level evidence highlights (examples). Rendered only when
   *  `showEvidence` is true. */
  highlights?: TokenHighlight[]
  /** Byte-range violation highlights. Always rendered. */
  ranges?: RangeHighlight[]
  showEvidence?: boolean
  /** Called with the rule id and the span element itself, so callers can
   *  anchor popovers to the violation glyph. Matches `TranslatedEditor.onRuleClick`. */
  onRangeClick?: (ruleId: string, anchor: HTMLElement, matchHash?: string) => void
}

export function HighlightedText({
  text, highlights = [], ranges = [],
  showEvidence = false, onRangeClick,
}: HighlightedTextProps) {
  const highlightMap = useMemo(() => {
    const map = new Map<string, number>()
    for (const h of highlights) map.set(h.token.toLowerCase(), h.colorIndex)
    return map
  }, [highlights])

  const chunks = useMemo(() => buildDisplayChunks(text, ranges), [ranges, text])
  const hasRanges = chunks.some((chunk) => chunk.ranges.length > 0)

  if (highlights.length === 0 && !hasRanges) return <span>{text}</span>

  return (
    <span>
      {chunks.map((chunk, i) => {
        if (chunk.ranges.length > 0) {
          return <RangeStack key={i} chunk={chunk} onRangeClick={onRangeClick} />
        }
        if (!showEvidence || highlights.length === 0) return <span key={i}>{chunk.text}</span>
        return <EvidenceTokens key={i} text={chunk.text} highlightMap={highlightMap} />
      })}
    </span>
  )
}

/** Nests one span per finding over the same characters, most severe innermost.
 *  A click is owned by the innermost span under the pointer, so the most
 *  severe finding wins a fully shared span while a partially overlapping one
 *  stays clickable on the characters only it covers. */
function RangeStack({
  chunk, onRangeClick,
}: { chunk: DisplayChunk; onRangeClick?: HighlightedTextProps["onRangeClick"] }) {
  let node: ReactNode = chunk.text
  for (let depth = 0; depth < chunk.ranges.length; depth++) {
    const range = chunk.ranges[chunk.ranges.length - 1 - depth]
    node = (
      <span
        role={onRangeClick ? "button" : undefined}
        tabIndex={onRangeClick ? 0 : undefined}
        onClick={onRangeClick ? (e) => {
          // A terminology blot can sit inside the managed-term popover
          // trigger, and a stacked finding sits inside another blot. Keep
          // this click owned by the innermost span so one gesture never
          // opens two popovers (AQU-1006 review regression).
          e.stopPropagation()
          onRangeClick(range.ruleId, e.currentTarget, range.matchHash)
        } : undefined}
        className={rangeSpanClass(range, depth)}
        data-rule-id={range.ruleId}
      >
        {node}
      </span>
    )
  }
  return <>{node}</>
}

function rangeSpanClass(range: RangeHighlight, depth: number): string {
  return cn(
    range.ruleId.startsWith("term:") && "terminology-highlight",
    "decoration-wavy underline",
    UNDERLINE_OFFSET_CLASSES[Math.min(depth, UNDERLINE_OFFSET_CLASSES.length - 1)],
    range.kind === "violation-major" && "decoration-red-500",
    range.kind === "violation-minor" && "decoration-amber-500",
    range.kind === "violation-waived" && "decoration-muted-foreground/60 opacity-60",
  )
}

/** Splits the text at every range boundary and hands each run the full set of
 *  ranges covering it. Ranges from different rules can overlap, and one can
 *  sit wholly inside another (EditorTable concatenates spans from every rule
 *  without merging) — every character is emitted exactly once and no finding
 *  is dropped (AQU-1633). */
function buildDisplayChunks(text: string, ranges: RangeHighlight[]): DisplayChunk[] {
  const normalized = normalizeDisplayRanges(text, ranges)
  if (normalized.length === 0) return [{ text, start: 0, ranges: [] }]

  const cuts = new Set<number>([0, text.length])
  for (const range of normalized) { cuts.add(range.start); cuts.add(range.end) }
  const offsets = [...cuts].sort((a, b) => a - b)

  const chunks: DisplayChunk[] = []
  for (let i = 0; i + 1 < offsets.length; i++) {
    const start = offsets[i]
    const end = offsets[i + 1]
    if (end <= start) continue
    const covering = normalized.filter((range) => range.start <= start && range.end >= end)
    chunks.push({ text: text.slice(start, end), start, ranges: stackOrder(covering) })
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

function EvidenceTokens({ text, highlightMap }: { text: string; highlightMap: Map<string, number> }) {
  const parts = text.split(/(\s+)/)
  return (
    <>
      {parts.map((part, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>
        // Unicode-aware: \w is ASCII-only and stripped accented/non-Latin
        // letters ("más" → "ms", "θεός" → ""), so highlights never matched
        // outside plain English. \p{M} keeps combining marks (niqqud etc.)
        // so the token matches what tokenizeText produces.
        const token = part.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "")
        const colorIdx = highlightMap.get(token)
        if (colorIdx !== undefined) {
          const color = EXAMPLE_COLORS[colorIdx % EXAMPLE_COLORS.length]
          return (
            <span
              key={i}
              style={{
                backgroundImage: `linear-gradient(to right, transparent, ${color}80 20%, ${color}80 80%, transparent)`,
                backgroundRepeat: "no-repeat",
                backgroundSize: "100% 2px",
                backgroundPosition: "0 100%",
                paddingBottom: "1px",
              }}
            >
              {part}
            </span>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

export function buildHighlightsFromExamples(
  examples: { matchedTokens: string[] }[],
  globalColorOffset = 0
): TokenHighlight[] {
  const highlights: TokenHighlight[] = []
  const seen = new Set<string>()
  for (let i = 0; i < examples.length; i++) {
    const colorIndex = (i + globalColorOffset) % EXAMPLE_COLORS.length
    for (const token of examples[i].matchedTokens) {
      const lower = token.toLowerCase()
      if (!seen.has(lower)) { seen.add(lower); highlights.push({ token: lower, colorIndex }) }
    }
  }
  return highlights
}
