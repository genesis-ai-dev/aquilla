import { useMemo } from "react"
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
}

/** When two ranges start at the same offset, the more severe one owns the span. */
const KIND_PRECEDENCE: Record<RangeHighlight["kind"], number> = {
  "violation-major": 0,
  "violation-minor": 1,
  "violation-waived": 2,
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
  onRangeClick?: (ruleId: string, anchor: HTMLElement) => void
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

  const displayRanges = useMemo(
    () => normalizeDisplayRanges(text, ranges),
    [ranges, text],
  )

  if (highlights.length === 0 && displayRanges.length === 0) return <span>{text}</span>

  // First split into chunks honoring ranges; then in non-ranged chunks apply
  // token-level evidence highlights when showEvidence is true.
  //
  // Ranges from different rules can overlap (EditorTable concatenates spans
  // from every rule without merging), so each range is clamped to the cursor:
  // the first range by start (severity-tiebroken) owns the shared sub-span,
  // later ranges keep only their uncovered tail. Without the clamp the
  // overlapping characters were emitted twice.
  const chunks: Array<{ text: string; start: number; range?: RangeHighlight }> = []
  let cursor = 0
  for (const r of displayRanges) {
    if (r.start > cursor) chunks.push({ text: text.slice(cursor, r.start), start: cursor })
    const start = Math.max(r.start, cursor)
    if (r.end <= start) continue // fully covered by an earlier range
    chunks.push({ text: text.slice(start, r.end), start, range: r })
    cursor = r.end
  }
  if (cursor < text.length) chunks.push({ text: text.slice(cursor), start: cursor })

  return (
    <span>
      {chunks.map((chunk, i) => {
        if (chunk.range) {
          return (
            <span
              key={i}
              role={onRangeClick ? "button" : undefined}
              tabIndex={onRangeClick ? 0 : undefined}
              onClick={onRangeClick ? (e) => onRangeClick(chunk.range!.ruleId, e.currentTarget) : undefined}
              className={cn(
                chunk.range.kind === "violation-major" && "decoration-wavy decoration-red-500 underline underline-offset-[3px]",
                chunk.range.kind === "violation-minor" && "decoration-wavy decoration-amber-500 underline underline-offset-[3px]",
                chunk.range.kind === "violation-waived" && "decoration-wavy decoration-muted-foreground/60 underline underline-offset-[3px] opacity-60",
              )}
              data-rule-id={chunk.range.ruleId}
            >
              {chunk.text}
            </span>
          )
        }
        if (!showEvidence || highlights.length === 0) return <span key={i}>{chunk.text}</span>
        return <EvidenceTokens key={i} text={chunk.text} highlightMap={highlightMap} />
      })}
    </span>
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
  out.sort(
    (a, b) =>
      a.start - b.start ||
      KIND_PRECEDENCE[a.kind] - KIND_PRECEDENCE[b.kind] ||
      b.end - a.end,
  )
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
