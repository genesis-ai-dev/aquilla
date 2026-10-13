// Voices (AQU-1687): the details behind a cell's voice chip.
//
// Every voice in the cell, in reading order, each once: speaker → addressee,
// the kind of speech, its delivery and quote level, how sure the data is and
// which datasets say so, a "Show every line by …" action per speaker, and
// where each name came from. Shown in the chip's popover on hover and on
// keyboard focus.

import { Fragment } from "react"
import { Button } from "@/components/ui/button"
import { PopoverTitle } from "@/components/ui/popover"
import type { BkpEntityId, BkpSpeech } from "@/lib/bible-data/pack-types"
import { distinctVoices, voiceSequence, type Voice } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { CellVoiceView } from "./voices-context"
import { evidenceSourceKey, labelSourceKey, narratorKey, speechTypeKey } from "./voice-text"

interface VoiceDetailsProps {
  id?: string
  view: CellVoiceView
  /** A speaker's name, or the "Unknown speaker" text. */
  nameOf: (entityId: BkpEntityId | undefined) => string
}

export function VoiceDetails({ id, view, nameOf }: VoiceDetailsProps) {
  const t = useT()
  const { context, voices } = view
  const shown = distinctVoices(voiceSequence(context.index, voices))

  // One "Show every line by …" per speaker, on that speaker's first speech.
  const offered = new Set<BkpEntityId>()
  const offersFilter = (speech: BkpSpeech) => {
    if (!speech.speaker || offered.has(speech.speaker)) return false
    offered.add(speech.speaker)
    return true
  }

  const named = new Set<BkpEntityId>()
  for (const voice of shown) {
    if (voice.kind !== "speech") continue
    if (voice.speech.speaker) named.add(voice.speech.speaker)
    if (voice.speech.addressee) named.add(voice.speech.addressee)
  }

  return (
    <div id={id} data-testid="voice-details" className="flex flex-col gap-2.5 text-xs">
      <PopoverTitle className="text-sm">{t("bibleData.voices.popoverTitle")}</PopoverTitle>
      <ul className="flex flex-col gap-2.5">
        {shown.map((voice) => (
          <li key={voiceListKey(voice)}>
            {voice.kind === "narrator" ? (
              <span className="font-medium">{t(narratorKey(context.index.narrator.kind))}</span>
            ) : (
              <SpeechDetails
                speech={voice.speech}
                nameOf={nameOf}
                hasAddresseeName={Boolean(voice.speech.addressee && context.labelFor(voice.speech.addressee))}
                onShowLines={offersFilter(voice.speech) ? context.showLinesBy : undefined}
              />
            )}
          </li>
        ))}
      </ul>
      {voices.approximate && (
        <p data-testid="voice-approximate" className="text-muted-foreground">
          {t("bibleData.voices.approximate")}
        </p>
      )}
      {named.size > 0 && (
        <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
          <p className="font-medium text-muted-foreground">{t("bibleData.voices.namesHeading")}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {[...named].map((id) => {
              const label = context.labelFor(id)
              if (!label) return null
              return (
                <Fragment key={id}>
                  <dt dir="auto">
                    <bdi>{label.label}</bdi>
                  </dt>
                  <dd className="text-muted-foreground">{t(labelSourceKey(label))}</dd>
                </Fragment>
              )
            })}
          </dl>
        </div>
      )}
    </div>
  )
}

function voiceListKey(voice: Voice): string {
  return voice.kind === "narrator" ? "narrator" : voice.speech.id
}

function SpeechDetails({
  speech,
  nameOf,
  hasAddresseeName,
  onShowLines,
}: {
  speech: BkpSpeech
  nameOf: (entityId: BkpEntityId | undefined) => string
  hasAddresseeName: boolean
  onShowLines?: (speaker: BkpEntityId) => void
}) {
  const t = useT()
  const fmt = useFormat()
  const speaker = nameOf(speech.speaker)
  const addressee = hasAddresseeName ? nameOf(speech.addressee) : null
  const typeKey = speechTypeKey(speech.type)
  const facts = [
    typeKey ? t(typeKey) : speech.type,
    speech.delivery ? t("bibleData.voices.delivery", { delivery: speech.delivery }) : undefined,
    t("bibleData.voices.level", { level: fmt.count(speech.level) }),
  ].filter((fact): fact is string => Boolean(fact))
  const sourcesOf = (sources: readonly string[]) =>
    fmt.list(
      sources.map((source) => {
        const key = evidenceSourceKey(source)
        return key ? t(key) : source
      }),
      { type: "conjunction" },
    )

  return (
    <div className="flex flex-col gap-0.5">
      <span dir="auto" className="font-medium">
        {/* The arrow is drawn, and mirrors in a right-to-left run; screen
            readers get the sentence instead. */}
        <span aria-hidden="true">
          <bdi>{speaker}</bdi>
          {addressee !== null && (
            <>
              <span className="mx-1 inline-block rtl:-scale-x-100">→</span>
              <bdi>{addressee}</bdi>
            </>
          )}
        </span>
        <span className="sr-only">
          {addressee !== null
            ? t("bibleData.voices.speaksTo", { speaker: fmt.isolate(speaker), addressee: fmt.isolate(addressee) })
            : speaker}
        </span>
      </span>
      <span className="text-muted-foreground">{facts.join(" · ")}</span>
      <span className="text-muted-foreground">
        {t("bibleData.voices.speakerEvidence", {
          confidence: fmt.isolate(fmt.percent(speech.speakerConf)),
          sources: sourcesOf(speech.speakerSources),
        })}
      </span>
      {addressee !== null && speech.addresseeConf !== undefined && (
        <span className="text-muted-foreground">
          {t("bibleData.voices.addresseeEvidence", {
            confidence: fmt.isolate(fmt.percent(speech.addresseeConf)),
            sources: sourcesOf(speech.addresseeSources ?? []),
          })}
        </span>
      )}
      {onShowLines && speech.speaker && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto self-start px-0 py-0.5 text-xs"
          onClick={() => {
            if (speech.speaker) onShowLines(speech.speaker)
          }}
        >
          {t("bibleData.voices.showLinesBy", { speaker: fmt.isolate(speaker) })}
        </Button>
      )}
    </div>
  )
}
