// The cell's Context tab (AQU-1689): the verse behind the cell, in the
// original language, for any project, whatever its source text.
//
// Sections, each shown only when it has something to show:
//   1. the verse's Greek words with their glosses; a word that refers to a
//      participant points to them ("αὐτόν → Jesus"), says how (Named /
//      Pronoun / Implied subject), and says when the data reached them through
//      a chain of two or more links, and through which words ("via λέγων");
//      an implied subject reads "[he = Jesus]";
//   2. the verse's voices, as the voice chip's details show them (when the
//      Voices enrichment is on);
//   3. AQU-1695: Translation Notes and Questions (Translation helps on), see
//      CellContextHelps. An anchored note's number marks its words in the
//      word list, which is never color alone. Key-term chips sit on the
//      words that carry a term (Key terms on).
// The notes and terms layers load when this tab first opens for a book.
//
// Not here yet: the M1 rhetorical-question hook and the tab's attention dot
// from Bible checks. Both need AQU-1688's check evaluator, which is on
// another PR stack (#1189).

import { useContext } from "react"
import { termsOfWord } from "@/lib/bible-data/helps-index"
import { mentionsIn, type MentionAt } from "@/lib/bible-data/people-index"
import type { BkpMention, BkpRef, BkpTextLayer, BkpWord, BkpWordId } from "@/lib/bible-data/pack-types"
import { cellVoicesFor } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { cn } from "@/lib/utils"
import { CellContextHelps } from "./CellContextHelps"
import { TermChip } from "./TermChip"
import { VoiceDetails } from "./VoiceDetails"
import { impliedSubjectHint, mentionKindKey } from "./people-text"
import { useCellHelps, type CellHelps } from "./useCellHelps"
import { BibleVoicesContext, type CellVoiceView } from "./voices-context"
import type { CellContextView } from "./whos-who-context"

/** Chains at or beyond this many links are worth saying out loud. */
const SHOW_HOPS_FROM = 2

interface CellContextTabProps {
  view: CellContextView
  /** The cell's own ref and type, for its voices. */
  cellRef: string
  cellType: string
}

export function CellContextTab({ view, cellRef, cellType }: CellContextTabProps) {
  const t = useT()
  const voicesContext = useContext(BibleVoicesContext)
  const voices = voicesContext ? cellVoicesFor(voicesContext.index, { ref: cellRef, type: cellType }, voicesContext.shared) : null
  const voiceView: CellVoiceView | null =
    voicesContext && voices ? { context: voicesContext, voices, chip: null, rails: [] } : null
  const helps = useCellHelps({
    book: view.context.index.book,
    refs: view.refs,
    notes: view.context.helps,
    terms: view.context.terms,
  })

  return (
    <div data-testid="cell-context-tab" className="flex flex-col gap-4 text-xs">
      <section className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t("bibleData.context.wordsHeading")}</h4>
        {view.approximate && <p className="text-muted-foreground">{t("bibleData.context.approximate")}</p>}
        {view.refs.map((ref) => (
          <VerseWords key={ref} view={view} verseRef={ref} showRef={view.refs.length > 1} helps={helps} />
        ))}
      </section>
      {voiceView && (
        <section className="border-t border-border/60 pt-3">
          <VoiceDetails
            view={voiceView}
            placement="section"
            nameOf={(entityId) =>
              (entityId ? voiceView.context.labelFor(entityId)?.label : undefined) ?? t("bibleData.voices.unknownSpeaker")
            }
          />
        </section>
      )}
      <CellContextHelps state={helps.notes} verseCount={view.refs.length} />
    </div>
  )
}

function VerseWords({
  view,
  verseRef,
  showRef,
  helps,
}: {
  view: CellContextView
  verseRef: BkpRef
  showRef: boolean
  helps: CellHelps
}) {
  const { context } = view
  const ids = context.text.verses[verseRef] ?? []
  const byWord = new Map(mentionsIn(context.index, [verseRef]).map((at) => [at.wordId, at]))
  return (
    <div className="flex flex-col gap-1">
      {showRef && <h5 className="font-medium text-muted-foreground">{verseRef}</h5>}
      {/* The pack's words are SBLGNT Greek (word ids "n…"). */}
      <ol className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-3 gap-y-1">
        {ids.map((wordId) => {
          const word = Object.hasOwn(context.text.words, wordId) ? context.text.words[wordId] : undefined
          if (!word) return null
          const at = byWord.get(wordId)
          const terms = helps.terms ? termsOfWord(helps.terms, wordId) : []
          return (
            <li
              key={wordId}
              data-word-id={wordId}
              data-notes={helps.noteIds.get(wordId)?.join(" ")}
              className="col-span-3 grid grid-cols-subgrid"
            >
              <NotedWord word={word} numbers={helps.noteNumbers.get(wordId)} />
              <span className="text-muted-foreground">{word.gloss}</span>
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                {at ? <Referent view={view} at={at} word={word.text} /> : null}
                {terms.map((term) => (
                  <TermChip key={term.id} term={term} />
                ))}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** A Greek word; with `numbers`, highlighted and marked with the notes that discuss it. */
function NotedWord({ word, numbers }: { word: BkpWord; numbers: readonly number[] | undefined }) {
  const t = useT()
  const fmt = useFormat()
  const noted = numbers !== undefined && numbers.length > 0
  return (
    <span>
      <span
        lang="grc"
        dir="ltr"
        data-noted={noted ? "true" : undefined}
        className={cn(
          "text-sm",
          noted &&
            "rounded-sm bg-amber-100 px-0.5 underline decoration-amber-600 underline-offset-4 dark:bg-amber-400/20 dark:decoration-amber-300",
        )}
      >
        {word.text}
        {noted && (
          <sup aria-hidden="true" className="ms-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
            {numbers.map((number) => fmt.count(number)).join(",")}
          </sup>
        )}
      </span>
      {noted && (
        <span className="sr-only">
          {t("bibleHelps.notes.wordSrOnly", {
            count: numbers.length,
            numbers: fmt.list(numbers.map((number) => fmt.count(number))),
          })}
        </span>
      )}
    </span>
  )
}

/** The words a mention's chain went through (pack 1.1), each as the text layer has it. */
function viaWords(mention: BkpMention, text: BkpTextLayer): BkpWord[] {
  const via: unknown = mention.via
  if (!Array.isArray(via)) return []
  return via.flatMap((id: unknown) =>
    typeof id === "string" && Object.hasOwn(text.words, id) ? [text.words[id as BkpWordId]] : [],
  )
}

function Referent({ view, at, word }: { view: CellContextView; at: MentionAt; word: string }) {
  const t = useT()
  const fmt = useFormat()
  const { context } = view
  const { entity, kind, hops } = at.mention
  const name = context.mentionName(at)
  const hint = impliedSubjectHint(t, fmt.isolate, {
    at,
    word: context.text.words[at.wordId],
    entities: context.index.entities,
    name,
    namesOnly: false,
    pronounOnly: false,
  })
  const kindKey = mentionKindKey(kind)
  const via = viaWords(at.mention, context.text).map((step) =>
    step.gloss
      ? t("bibleHelps.context.viaWord", { word: fmt.isolate(step.text), gloss: fmt.isolate(step.gloss) })
      : fmt.isolate(step.text),
  )
  const facts = [
    kindKey ? t(kindKey) : null,
    hops >= SHOW_HOPS_FROM ? t("bibleData.whosWho.hops", { count: hops }) : null,
    // A chain, in order: listed without "and".
    via.length > 0 ? t("bibleHelps.context.via", { words: fmt.list(via, { type: "unit" }) }) : null,
  ].filter((fact): fact is string => fact !== null)
  return (
    <span data-testid="context-referent" data-entity={entity} dir="auto">
      <span aria-hidden="true">
        {hint ?? (
          <>
            <span className="me-1 inline-block rtl:-scale-x-100">→</span>
            <bdi className="font-medium">{name}</bdi>
          </>
        )}
      </span>
      <span className="sr-only">
        {t("bibleData.context.refersToSrOnly", { word, name: fmt.isolate(name) })}
      </span>
      {facts.length > 0 && <span className="ms-2 text-muted-foreground">{facts.join(" · ")}</span>}
    </span>
  )
}

