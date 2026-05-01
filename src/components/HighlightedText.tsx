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

  const sortedRanges = useMemo(
    () => [...ranges].sort((a, b) => a.start - b.start),
    [ranges],
  )

  if (highlights.length === 0 && ranges.length === 0) return <span>{text}</span>

  // First split into chunks honoring ranges; then in non-ranged chunks apply
  // token-level evidence highlights when showEvidence is true.
  const chunks: Array<{ text: string; start: number; range?: RangeHighlight }> = []
  let cursor = 0
  for (const r of sortedRanges) {
    if (r.start > cursor) chunks.push({ text: text.slice(cursor, r.start), start: cursor })
    chunks.push({ text: text.slice(r.start, r.end), start: r.start, range: r })
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
                "cursor-pointer",
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

function EvidenceTokens({ text, highlightMap }: { text: string; highlightMap: Map<string, number> }) {
  const parts = text.split(/(\s+)/)
  return (
    <>
      {parts.map((part, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>
        const token = part.toLowerCase().replace(/[^\w]/g, "")
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
