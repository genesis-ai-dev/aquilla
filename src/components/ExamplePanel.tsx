import { BookOpen } from "lucide-react"
import type { ScoredPair } from "@/lib/search/dual-index"
import { HighlightedText, EXAMPLE_COLORS } from "./HighlightedText"
import { tokenizeText } from "@/lib/search/tokenizer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/lib/i18n/I18nProvider"

export function ExamplePanel({
  examples, globalColorOffset = 0,
}: {
  examples: ScoredPair[]
  globalColorOffset?: number
  /** @deprecated No longer used — popover manages its own open state */
  expanded?: boolean
  /** @deprecated No longer used — popover manages its own open state */
  onExpandedChange?: (expanded: boolean) => void
}) {
  const t = useT()
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
              {t("search.examples.count", {
                count: examples.length,
              })}
            </button>
          }
        />
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-80 space-y-2 p-3 text-xs"
          aria-label={t("search.examples.popoverAriaLabel")}
        >
          {examples.map((ex, i) => {
            const colorIndex = (i + globalColorOffset) % EXAMPLE_COLORS.length
            const sourceTokens = new Set(tokenizeText(ex.source))
            const matched = ex.matchedTokens.filter((tok) => sourceTokens.has(tok.toLowerCase()))
            return (
              <div
                key={ex.cellId}
                className="rounded border-l-2 bg-muted/30 p-2 space-y-1"
                style={{ borderLeftColor: EXAMPLE_COLORS[colorIndex] }}
              >
                <div className="text-xs text-muted-foreground/70">
                  {t("search.side.source")}
                </div>
                <div className="text-muted-foreground">
                  <HighlightedText
                    text={ex.source}
                    highlights={matched.map((tok) => ({ token: tok, colorIndex }))}
                  />
                </div>
                <div className="text-xs text-muted-foreground/70 mt-1">
                  {t("search.side.target")}
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
