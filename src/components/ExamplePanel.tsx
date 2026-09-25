import { BookOpen, CornerDownLeft } from "lucide-react"
import { useMemo } from "react"
import type { ScoredPair } from "@/lib/search/dual-index"
import {
  diffSourceTokens,
  rankTmMatches,
  type DiffSegment,
  type MatchBand,
  type TmMatch,
} from "@/lib/search/fuzzy-match"
import { HighlightedText, EXAMPLE_COLORS } from "./HighlightedText"
import { tokenizeText } from "@/lib/search/tokenizer"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/** Where an example pair came from, resolved by the host from the pair's fileId. */
export interface ExampleOrigin {
  fileName: string
  /** True for an imported TMX file — those rows are a translation memory, not
   *  this project's own translated cells, and say so (AQU-1393). */
  isTranslationMemory: boolean
}

/**
 * Band → badge styling. Only `exact` gets a filled badge: it is the one band
 * that licenses the one-click insert, and a page of filled badges would make
 * "identical source" look like just another shade of similar.
 */
const BAND_BADGE: Record<MatchBand, string> = {
  exact: "bg-emerald-600 text-white",
  high: "border border-emerald-600/60 text-emerald-700 dark:text-emerald-400",
  good: "border border-amber-600/60 text-amber-700 dark:text-amber-400",
  fair: "border border-muted-foreground/40 text-muted-foreground",
  example: "border border-muted-foreground/30 text-muted-foreground/80",
}

export function ExamplePanel({
  examples, globalColorOffset = 0, currentSource, originFor, onInsert,
}: {
  examples: ScoredPair[]
  globalColorOffset?: number
  /**
   * Source text of the cell these examples were retrieved for. Without it the
   * panel cannot say how similar anything is, so it keeps its pre-AQU-1393
   * behaviour and renders plain token-highlighted examples.
   */
  currentSource?: string
  originFor?: (fileId: string) => ExampleOrigin | undefined
  /**
   * Fills the target editor with an exact match's existing translation. Omitted
   * (or absent) when the row isn't writable — the Insert button then isn't
   * rendered at all rather than shown and refusing.
   */
  onInsert?: (target: string) => void
}) {
  const t = useT()
  // Ranking is O(candidates) edit distances, so it is memoized on the retrieved
  // pairs + this cell's source: the popover lives inside a table row that
  // re-renders on every keystroke in the neighbouring editor.
  const matches = useMemo<TmMatch[]>(
    () => (currentSource ? rankTmMatches(currentSource, examples) : []),
    [currentSource, examples],
  )
  // Colour stays keyed to RETRIEVAL order, not display order, so a row's swatch
  // is the same colour whichever way the list is sorted — and keeps agreeing
  // with `buildHighlightsFromExamples`, which colours the source-text evidence
  // underlines from that same order.
  const retrievalIndex = useMemo(
    () => new Map(examples.map((pair, index) => [pair.cellId, index])),
    [examples],
  )
  if (examples.length === 0) return null
  const rows: readonly (ScoredPair | TmMatch)[] = matches.length > 0 ? matches : examples

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
          {rows.map((ex, i) => {
            const colorIndex =
              ((retrievalIndex.get(ex.cellId) ?? i) + globalColorOffset) % EXAMPLE_COLORS.length
            const sourceTokens = new Set(tokenizeText(ex.source))
            const matched = ex.matchedTokens.filter((tok) => sourceTokens.has(tok.toLowerCase()))
            const band = "band" in ex ? ex.band : undefined
            const percent = "percent" in ex ? ex.percent : undefined
            const origin = originFor?.(ex.fileId)
            const canInsert = band === "exact" && !!onInsert && ex.target.trim() !== ""
            return (
              <div
                key={ex.cellId}
                data-testid="example-row"
                data-match-band={band}
                className="rounded border-s-2 bg-muted/30 p-2 space-y-1"
                style={{ borderLeftColor: EXAMPLE_COLORS[colorIndex] }}
              >
                {band && (
                  <div className="flex items-center justify-between gap-2">
                    <span
                      data-testid="example-match-badge"
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium leading-none",
                        BAND_BADGE[band],
                      )}
                    >
                      {band === "exact"
                        ? t("search.examples.exactMatch")
                        : band === "example"
                          ? t("search.examples.looseLabel")
                          : t("search.examples.matchPercent", { percent: percent ?? 0 })}
                    </span>
                    {canInsert && (
                      <button
                        type="button"
                        data-testid="example-insert"
                        aria-label={t("search.examples.insertAriaLabel")}
                        className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium hover:bg-accent"
                        onClick={() => onInsert?.(ex.target)}
                      >
                        <CornerDownLeft className="h-2.5 w-2.5" />
                        {t("search.examples.insert")}
                      </button>
                    )}
                  </div>
                )}
                <div className="text-xs text-muted-foreground/70">
                  {t("editor.column.source")}
                </div>
                <div className="text-muted-foreground">
                  {band && band !== "example" && currentSource ? (
                    <MatchDiff current={currentSource} candidate={ex.source} />
                  ) : (
                    <HighlightedText
                      text={ex.source}
                      highlights={matched.map((tok) => ({ token: tok, colorIndex }))}
                    />
                  )}
                </div>
                <div className="text-xs text-muted-foreground/70 mt-1">
                  {t("editor.column.target")}
                </div>
                <div className="font-medium">{ex.target}</div>
                {origin && (
                  <div data-testid="example-origin" className="text-[10px] text-muted-foreground/70">
                    {origin.isTranslationMemory
                      ? t("search.examples.originTranslationMemory", { fileName: origin.fileName })
                      : t("search.examples.originFile", { fileName: origin.fileName })}
                  </div>
                )}
              </div>
            )
          })}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/**
 * The match's source with its differences from the current cell marked: words
 * only this match has are underlined, words the current cell has and this match
 * lacks are struck through in place. That is the pair a translator checks before
 * reusing a near match — the percentage says how far off it is, this says where.
 */
function MatchDiff({ current, candidate }: { current: string; candidate: string }) {
  const t = useT()
  const segments = useMemo(() => diffSourceTokens(current, candidate), [current, candidate])
  return (
    <span data-testid="example-diff">
      {segments.map((segment: DiffSegment, i) =>
        segment.kind === "equal" ? (
          <span key={i}>{segment.text}</span>
        ) : segment.kind === "added" ? (
          <ins
            key={i}
            aria-label={t("search.examples.diffAddedAriaLabel")}
            className="bg-emerald-500/15 no-underline decoration-emerald-600 underline-offset-2 underline"
          >
            {segment.text}
          </ins>
        ) : (
          <del
            key={i}
            aria-label={t("search.examples.diffRemovedAriaLabel")}
            className="text-muted-foreground/60 line-through"
          >
            {segment.text}
          </del>
        ),
      )}
    </span>
  )
}
