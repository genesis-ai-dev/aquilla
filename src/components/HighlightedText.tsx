import { useMemo, type ReactNode } from "react"
import { buildDisplayChunks, rangeSpanClass, type DisplayChunk, type RangeHighlight } from "@/lib/richtext/rule-ranges"

// AQU-1757: the range model and its underline classes live in
// lib/richtext/rule-ranges so the rich-text source path draws identically.
export type { RangeHighlight }

export const EXAMPLE_COLORS = [
  "#3b82f6", "#f97316", "#22c55e", "#a855f7",
  "#14b8a6", "#f43f5e", "#eab308", "#6366f1",
]

export interface TokenHighlight {
  token: string
  colorIndex: number
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
          onRangeClick(range.ruleId, e.currentTarget)
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
