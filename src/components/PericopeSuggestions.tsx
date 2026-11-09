import { useState } from "react"
import { ArrowRightToLine } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { getBookName } from "@/lib/file-labeling/bible-book-names"
import { useT } from "@/lib/i18n/I18nProvider"
import type { PericopeSuggestion } from "@/lib/pericope/suggest"
import type { VerseAddress } from "@/lib/pericope/sections"

/**
 * "Where should I work next?" for a book of the Bible (AQU-515).
 *
 * Rendered as an icon button inside the chapter navigator's button group
 * (prev, picker, this, next). The chapter picker lists every division in the file; this lists
 * the two-to-four ranges that surveyed Bibles actually break at, starting from
 * where the translator left off. It renders nothing when there is nothing to
 * suggest — a non-scripture file, a finished book, a dataset that did not load
 * — so the toolbar is unchanged for everyone it cannot help.
 */
export function PericopeSuggestions({
  suggestions,
  onSelect,
}: {
  suggestions: readonly PericopeSuggestion[]
  onSelect: (suggestion: PericopeSuggestion) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)

  if (suggestions.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={t("editor.pericope.trigger")}
            title={t("editor.pericope.trigger")}
          >
            <ArrowRightToLine aria-hidden="true" />
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 p-2">
        <PopoverTitle className="px-2 pb-1 text-xs font-medium text-muted-foreground">
          {t("editor.pericope.heading")}
        </PopoverTitle>
        <ul className="flex flex-col">
          {suggestions.map((suggestion) => (
            <li key={suggestion.key}>
              <button
                type="button"
                className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-hidden"
                onClick={() => {
                  setOpen(false)
                  onSelect(suggestion)
                }}
              >
                <span className="text-sm font-medium tabular-nums">
                  {/* AQU-2158: each row names its own book, so a range can
                      never be relabelled with the first row's book. */}
                  {t("editor.pericope.range", {
                    book: getBookName(suggestion.book) ?? suggestion.book,
                    start: verseLabel(suggestion.start),
                    end: verseLabel(suggestion.end),
                  })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {suggestion.continuation
                    ? t("editor.pericope.continues")
                    : t("editor.pericope.agreement", { count: suggestion.translations })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function verseLabel(address: VerseAddress): string {
  return `${address.chapter}:${address.verse}`
}
