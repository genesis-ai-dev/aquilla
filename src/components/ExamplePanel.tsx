import { BookOpen } from "lucide-react"
import type { ScoredPair } from "@/lib/search/dual-index"
import { HighlightedText, EXAMPLE_COLORS } from "./HighlightedText"
import { tokenizeText } from "@/lib/search/tokenizer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function ExamplePanel({
  examples, globalColorOffset = 0,
}: {
  examples: ScoredPair[]
  globalColorOffset?: number
}) {
  if (examples.length === 0) return null

  return (
    <div className="mt-2">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <BookOpen className="h-3 w-3" />
              {examples.length} example{examples.length !== 1 ? "s" : ""}
            </button>
          }
        />
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-80 space-y-2 p-3 text-xs"
          aria-label="Translation examples"
        >
          {examples.map((ex, i) => {
            const colorIndex = (i + globalColorOffset) % EXAMPLE_COLORS.length
            const sourceTokens = new Set(tokenizeText(ex.source))
            const matched = ex.matchedTokens.filter((t) => sourceTokens.has(t.toLowerCase()))
            return (
              <div
                key={ex.cellId}
                className="rounded border-l-2 bg-muted/30 p-2 space-y-1"
                style={{ borderLeftColor: EXAMPLE_COLORS[colorIndex] }}
              >
                <div className="text-xs text-muted-foreground/70">
                  Source
                </div>
                <div className="text-muted-foreground">
                  <HighlightedText
                    text={ex.source}
                    highlights={matched.map((t) => ({ token: t, colorIndex }))}
                  />
                </div>
                <div className="text-xs text-muted-foreground/70 mt-1">
                  Target
                </div>
                <div className="font-medium">{ex.target}</div>
              </div>
            )
          })}
        </PopoverContent>
      </Popover>
    </div>
  )
}
