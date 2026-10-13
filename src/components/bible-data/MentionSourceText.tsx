// Who's Who (AQU-1689): a source cell's text with its mention words.
//
// Used only for a cell whose words are the pack's words (see
// macula-alignment): a Greek or Hebrew source. Every word that refers to a
// participant becomes a MentionToken; an implied subject gets a quiet hint
// before its verb ("[he = Jesus]") when the person's option allows and the
// verb's form settles the pronoun (the Context tab lists every one). The rest
// of the text renders as the editor always renders it, through `renderSlice`,
// so terminology lookups and rule findings keep working between mentions.

import { Fragment, useEffect, useRef, type ReactNode } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { MentionToken } from "./MentionToken"
import { impliedSubjectHint } from "./people-text"
import type { CellMentionView, CellMentionWord } from "./whos-who-context"

interface MentionSourceTextProps {
  view: CellMentionView
  cellId: string
  text: string
  /**
   * Render the text from `start` to `end`. Inside a mention it must hold no
   * interactive element: the mention word is already a button.
   */
  renderSlice: (start: number, end: number, insideMention: boolean) => ReactNode
}

export function MentionSourceText({ view, cellId, text, renderSlice }: MentionSourceTextProps) {
  const t = useT()
  const fmt = useFormat()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { context } = view
  const { store } = context

  // A previous/next jump that asked for keyboard focus lands here: on this
  // participant's first word in the cell, without a second scroll.
  useEffect(() => {
    const take = () => {
      const entity = store.takeFocusRequest(cellId)
      if (!entity) return
      const words = containerRef.current?.querySelectorAll<HTMLElement>("[data-mention-entity]") ?? []
      ;[...words].find((element) => element.dataset.mentionEntity === entity)?.focus({ preventScroll: true })
    }
    take()
    return store.subscribe(take)
  }, [store, cellId])

  const hintFor = (word: CellMentionWord): string | null =>
    context.hints === "off"
      ? null
      : impliedSubjectHint(t, fmt.isolate, {
          at: word.at,
          word: context.text?.words[word.wordId],
          entities: context.index.entities,
          name: context.mentionName(word.at),
          namesOnly: context.hints === "names",
          // At rest, only where the verb's own form says who: "[he = Jesus]".
          pronounOnly: true,
        })

  const parts: ReactNode[] = []
  let cursor = 0
  view.words.forEach((word, position) => {
    if (word.start > cursor) {
      parts.push(<Fragment key={`gap-${position}`}>{renderSlice(cursor, word.start, false)}</Fragment>)
    }
    const hint = hintFor(word)
    if (hint) {
      parts.push(
        // The verb's own name says who its subject is; the hint is for the eye.
        <span
          key={`hint-${position}`}
          aria-hidden="true"
          data-testid="implied-subject-hint"
          data-selection-ignore=""
          dir="auto"
          className="me-1 select-none text-[0.75em] text-muted-foreground"
        >
          {hint}
        </span>,
      )
    }
    parts.push(
      <MentionToken key={`mention-${position}`} view={view} word={word} text={text.slice(word.start, word.end)}>
        {renderSlice(word.start, word.end, true)}
      </MentionToken>,
    )
    cursor = word.end
  })
  if (cursor < text.length) parts.push(<Fragment key="tail">{renderSlice(cursor, text.length, false)}</Fragment>)

  return (
    <div ref={containerRef} data-testid="mention-source-text">
      {parts}
    </div>
  )
}
