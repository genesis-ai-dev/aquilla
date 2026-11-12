// Who's Who (AQU-1689): one source word that refers to a participant.
//
// Hovering or focusing it lights its participant, and every mention of that
// participant in the rendered rows tints: a faint wash plus a solid
// underline, like the term-lookup marker (src/index.css, `.mention-mark`). At
// rest a mention has a dotted underline, so it can be found without hovering
// ("hover" mode), or its participant's thread tint ("always" mode). The tint
// is never the only signal: the popover and the accessible name say who it is.
//
// Hover and keyboard focus light the thread; the popover with who it is opens
// on a click (Enter or Space from the keyboard). It used to open on hover and
// on focus too; AQU-2260 (Oct 29) ended that.
//
// AQU-1694: on a gateway-language source the word was placed by the stored
// word alignment. Below the confidence threshold it is "approximate": its lit
// and "always" tints draw dotted, and its name says so.

import { useId, useState, type ReactNode } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { threadSlot } from "@/lib/bible-data/people-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"
import { MentionDetails } from "./MentionDetails"
import { useIsLit } from "./mention-highlight-store"
import { mentionKindKey } from "./people-text"
import type { CellMentionView, CellMentionWord } from "./whos-who-context"

interface MentionTokenProps {
  view: CellMentionView
  word: CellMentionWord
  /** The word as the cell spells it, for the accessible name. */
  text: string
  children: ReactNode
}

export function MentionToken({ view, word, text, children }: MentionTokenProps) {
  const t = useT()
  const fmt = useFormat()
  const { context } = view
  const { entity, kind } = word.at.mention
  const lit = useIsLit(context.store, entity)
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const always = context.highlights === "always"
  const slot = always ? threadSlot(context.index, word.at.ref, entity) : null
  const kindKey = mentionKindKey(kind)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="mention"
        data-mention-entity={entity}
        data-mention-kind={kind}
        data-mention-lit={lit ? "true" : undefined}
        data-mention-tinted={always ? "true" : undefined}
        data-thread-slot={slot ?? undefined}
        data-mention-approximate={word.approximate ? "true" : undefined}
        aria-label={t(word.approximate ? "bibleAlignment.mentionApproximateAria" : "bibleData.whosWho.mentionAria", {
          word: text,
          kind: kindKey ? t(kindKey) : kind,
          name: fmt.isolate(context.mentionName(word.at)),
        })}
        className={cn(
          "mention-mark inline cursor-pointer appearance-none border-0 bg-transparent p-0 text-start [color:inherit] [font:inherit]",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        onPointerEnter={() => context.store.light(entity, "hover")}
        onPointerLeave={() => context.store.unlight(entity, "hover")}
        onFocus={() => context.store.light(entity, "focus")}
        onBlur={() => context.store.unlight(entity, "focus")}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80">
        <MentionDetails
          id={contentId}
          view={view}
          at={word.at}
          placement={word.bridged ? (word.approximate ? "approximate" : "aligned") : "exact"}
          onJumped={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
