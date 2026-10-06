// The cell's Context tab (AQU-1695): Translation Notes and Questions.
//
// A note whose Greek quote the pack found in one place ("anchored") is
// numbered, and the same number marks its words in the tab's word list. Every
// other note (found in several places, in none, or with no quote at all) is
// listed under "Notes on this verse", without highlights. A question shows
// the question; its answer is behind a disclosure. A note or question on
// several verses says which. Their text is unfoldingWord's English, marked as
// such. The pack gives no link to a note's full text, so there is none.

import type { BkpNote, BkpQuestion } from "@/lib/bible-data/pack-types"
import { noteParagraphs, noteRange, questionRange } from "@/lib/bible-data/helps-index"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { noteCategoryKey } from "./helps-text"
import type { CellHelpsState } from "./useCellHelps"

const SECTION = "flex flex-col gap-2 border-t border-border/60 pt-3"

interface CellContextHelpsProps {
  state: CellHelpsState
  /** How many verses the cell holds, for "Notes on this verse". */
  verseCount: number
}

export function CellContextHelps({ state, verseCount }: CellContextHelpsProps) {
  const t = useT()
  if (state.status === "off") return null
  if (state.status === "loading") {
    return (
      <div data-testid="context-helps-loading" className={SECTION}>
        <Spinner className="size-3.5 text-muted-foreground" />
      </div>
    )
  }
  if (state.status === "unavailable") {
    // A book the pack has no notes for is not news.
    if (state.reason === "not-found") return null
    return (
      <p className={`${SECTION} text-muted-foreground`}>
        {t(
          state.reason === "offline"
            ? "bibleHelps.notes.unavailable.offline"
            : "bibleHelps.notes.unavailable.invalid",
        )}
      </p>
    )
  }

  const { anchored, other } = state.notes
  return (
    <>
      {(anchored.length > 0 || other.length > 0) && (
        <section data-testid="context-notes" className={SECTION}>
          <h4 className="text-sm font-medium">{t("editor.tn.title")}</h4>
          {anchored.length > 0 && (
            <ol className="flex flex-col gap-2.5">
              {anchored.map((note, position) => (
                <li key={note.id}>
                  <NoteItem note={note} number={position + 1} />
                </li>
              ))}
            </ol>
          )}
          {other.length > 0 && (
            <div data-testid="context-other-notes" className="flex flex-col gap-2">
              <h5 className="font-medium text-muted-foreground">
                {t("bibleHelps.notes.otherHeading", { count: verseCount })}
              </h5>
              <ul className="flex flex-col gap-2.5">
                {other.map((note) => (
                  <li key={note.id}>
                    <NoteItem note={note} number={null} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      {state.questions.length > 0 && <QuestionsSection questions={state.questions} />}
    </>
  )
}

function NoteItem({ note, number }: { note: BkpNote; number: number | null }) {
  const t = useT()
  const fmt = useFormat()
  const range = noteRange(note)
  // Only the id, ref and text are checked when the file is read.
  const quote: unknown = note.quote
  return (
    <article data-testid="context-note" data-note-id={note.id} data-anchor={note.anchor ?? "none"} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {number !== null && (
          <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-semibold text-amber-900 dark:bg-amber-400/20 dark:text-amber-200">
            <span aria-hidden="true">{fmt.count(number)}</span>
            <span className="sr-only">{t("bibleHelps.notes.numberSrOnly", { number: fmt.count(number) })}</span>
          </span>
        )}
        <span
          data-testid="note-category"
          data-category={note.category ?? ""}
          className="rounded-sm border border-border px-1.5 py-px text-[10px] text-muted-foreground"
        >
          {t(noteCategoryKey(note.category))}
        </span>
        {range && (
          <span className="text-[10px] text-muted-foreground">
            {t("bibleHelps.verseRange", { range: fmt.isolate(range) })}
          </span>
        )}
      </div>
      {/* An unhighlighted note says which Greek it is about. */}
      {number === null && typeof quote === "string" && quote !== "" && (
        <p lang="grc" dir="ltr" className="text-sm">
          {quote}
        </p>
      )}
      <div lang="en" dir="auto" className="flex flex-col gap-1">
        {noteParagraphs(note.text).map((paragraph, position) => (
          <p key={position}>{paragraph}</p>
        ))}
      </div>
    </article>
  )
}

function QuestionsSection({ questions }: { questions: readonly BkpQuestion[] }) {
  const t = useT()
  const fmt = useFormat()
  return (
    <section data-testid="context-questions" className={SECTION}>
      <h4 className="text-sm font-medium">{t("bibleHelps.questions.heading")}</h4>
      <ul className="flex flex-col gap-1.5">
        {questions.map((question) => {
          const range = questionRange(question)
          return (
            <li key={question.id} data-testid="context-question" data-question-id={question.id}>
              <details>
                <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  <span lang="en" dir="auto">
                    {question.q}
                  </span>
                  {range && (
                    <span className="ms-2 text-[10px] text-muted-foreground">
                      {t("bibleHelps.verseRange", { range: fmt.isolate(range) })}
                    </span>
                  )}
                </summary>
                <p lang="en" dir="auto" data-testid="context-answer" className="mt-1 ps-4 text-muted-foreground">
                  {question.a}
                </p>
              </details>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
