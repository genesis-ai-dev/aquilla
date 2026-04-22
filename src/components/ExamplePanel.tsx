import { useState } from "react"
import { BookOpen, ChevronDown, ChevronRight } from "lucide-react"
import type { ScoredPair } from "@/lib/search/dual-index"
import { HighlightedText, EXAMPLE_COLORS } from "./HighlightedText"
import { tokenizeText } from "@/lib/search/tokenizer"

export function ExamplePanel({ examples, globalColorOffset = 0 }: { examples: ScoredPair[]; globalColorOffset?: number }) {
  const [expanded, setExpanded] = useState(false)
  if (examples.length === 0) return null

  return (
    <div className="mt-1">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <BookOpen className="h-3 w-3" />
        {examples.length} example{examples.length !== 1 ? "s" : ""}
      </button>
      {expanded && (
        <div className="mt-1 space-y-1.5 rounded border bg-muted/30 p-2">
          {examples.map((ex, i) => {
            const colorIndex = (i + globalColorOffset) % EXAMPLE_COLORS.length
            const sourceTokens = new Set(tokenizeText(ex.source))
            const matched = ex.matchedTokens.filter((t) => sourceTokens.has(t.toLowerCase()))
            return (
              <div key={ex.cellId} className="rounded border-l-2 bg-background p-2 text-xs" style={{ borderLeftColor: EXAMPLE_COLORS[colorIndex] }}>
                <div className="text-muted-foreground">
                  <HighlightedText text={ex.source} highlights={matched.map((t) => ({ token: t, colorIndex }))} />
                </div>
                <div className="mt-0.5 font-medium">{ex.target}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
