// Key terms (AQU-1695): a chip on a Greek word in the Context tab, naming a
// key term the word carries (Translation Words or an ACAI keyterm). Its
// popover names the term and where it comes from. It opens on a click (Enter
// or Space from the keyboard), like the mention and voice popovers; never on
// hover or on focus alone (AQU-2260, Oct 29).
//
// AQU-1700: a Simplified Chinese interface reads a title's Simplified form
// (`cmn-Hans`) first; with only the Traditional one (`cmn`), the popover says
// so.

import { BookMarked } from "lucide-react"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import type { WordTerm } from "@/lib/bible-data/helps-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"
import { termSourceKey } from "./helps-text"
import { useLabelText } from "./useEntityLabels"

export function TermChip({ term: { id, term } }: { term: WordTerm }) {
  const t = useT()
  const fmt = useFormat()
  const pick = useLabelText()
  // `titles` has the other languages; the English title is `title`.
  const title = pick(term.titles) ?? { text: term.title, lang: "en" }
  const sourceKey = termSourceKey(term.source)

  return (
    <Popover>
      <PopoverTrigger
        data-testid="term-chip"
        data-term={id}
        aria-label={t("bibleHelps.terms.chipAria", { title: fmt.isolate(title.text) })}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-sky-700/40 px-1.5 py-px text-[10px] leading-4 text-sky-900 dark:border-sky-300/40 dark:text-sky-200",
          "cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <BookMarked className="size-2.5 shrink-0" aria-hidden="true" />
        <span lang={title.lang} dir="auto">
          {title.text}
        </span>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-64">
        <div data-testid="term-details" className="flex flex-col gap-1 text-xs">
          <PopoverTitle className="text-sm" lang={title.lang} dir="auto">
            {title.text}
          </PopoverTitle>
          {title.otherScript && (
            <p data-testid="term-other-script" className="text-muted-foreground">
              {t("bibleHelps.terms.traditionalCharacters")}
            </p>
          )}
          {sourceKey && <p className="text-muted-foreground">{t(sourceKey)}</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
