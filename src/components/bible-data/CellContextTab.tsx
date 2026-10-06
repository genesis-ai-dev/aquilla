// The cell's Context tab (AQU-1689): the verse behind the cell, in the
// original language, for any project, whatever its source text.
//
// Sections, each shown only when it has something to show:
//   1. the verse's Greek words with their glosses; a word that refers to a
//      participant points to them ("αὐτόν → Jesus"), says how (Named /
//      Pronoun / Implied subject), and says when the data reached them through
//      a chain of two or more links; an implied subject reads "[he = Jesus]";
//   2. the verse's voices, as the voice chip's details show them (when the
//      Voices enrichment is on).
// Pack slice 2 adds anchored Translation Notes and Questions (the `notes`
// layer): they go in as a third section, after the voices, built the same
// way (nothing rendered when the verse has none).

import { useContext } from "react"
import { mentionsIn, type MentionAt } from "@/lib/bible-data/people-index"
import type { BkpRef } from "@/lib/bible-data/pack-types"
import { cellVoicesFor } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { VoiceDetails } from "./VoiceDetails"
import { impliedSubjectHint, mentionKindKey } from "./people-text"
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

  return (
    <div data-testid="cell-context-tab" className="flex flex-col gap-4 text-xs">
      <section className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">{t("bibleData.context.wordsHeading")}</h4>
        {view.approximate && <p className="text-muted-foreground">{t("bibleData.context.approximate")}</p>}
        {view.refs.map((ref) => (
          <VerseWords key={ref} view={view} verseRef={ref} showRef={view.refs.length > 1} />
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
    </div>
  )
}

function VerseWords({ view, verseRef, showRef }: { view: CellContextView; verseRef: BkpRef; showRef: boolean }) {
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
          return (
            <li key={wordId} data-word-id={wordId} className="col-span-3 grid grid-cols-subgrid">
              <span lang="grc" dir="ltr" className="text-sm">
                {word.text}
              </span>
              <span className="text-muted-foreground">{word.gloss}</span>
              <span>{at ? <Referent view={view} at={at} word={word.text} /> : null}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function Referent({ view, at, word }: { view: CellContextView; at: MentionAt; word: string }) {
  const t = useT()
  const fmt = useFormat()
  const { context } = view
  const { entity, kind, hops } = at.mention
  const name = context.nameOf(entity)
  const hint = impliedSubjectHint(t, fmt.isolate, {
    at,
    word: context.text.words[at.wordId],
    entities: context.index.entities,
    name,
    namesOnly: false,
  })
  const kindKey = mentionKindKey(kind)
  const facts = [
    kindKey ? t(kindKey) : null,
    hops >= SHOW_HOPS_FROM ? t("bibleData.whosWho.hops", { count: hops }) : null,
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
