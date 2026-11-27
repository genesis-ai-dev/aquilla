// AQU-2426: what transcribing will cost, as board 58 draws it — four short
// lines (Audio, Requests, Roughly how long, Model) and a Credits line, in a
// bordered box with the labels in a muted column. Shared by the import's cost
// step and Split into lines…. Everything comes from `estimateTranscriptionCost`,
// worked out before anything runs.

import { useId } from "react"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { audioMinutes, roundedDuration, type SourceModel, type TranscriptionCost } from "@/lib/audio/transcription-cost"

type T = ReturnType<typeof useT>

const MODEL_KEY: Record<SourceModel, "settings.transcription.model.whisper" | "settings.transcription.model.qwen" | "settings.transcription.model.omni"> = {
  whisper: "settings.transcription.model.whisper",
  "qwen3-asr": "settings.transcription.model.qwen",
  "omni-ctc": "settings.transcription.model.omni",
}

/** "52 minutes", "1 hour 40 minutes", "1 minute 12 seconds", "40 seconds".
 *  Under ten minutes the seconds are kept, so 72 s reads "1 minute 12
 *  seconds" beside its 2 one-minute requests, never "1 minute". */
export function audioLength(t: T, ms: number): string {
  if (ms < 60_000) return t("audio.transcribeCost.seconds", { count: Math.max(1, Math.round(ms / 1000)) })
  if (ms < 10 * 60_000) {
    const total = Math.round(ms / 1000)
    const whole = Math.floor(total / 60)
    const rest = total % 60
    const m = t("audio.transcribeCost.minutes", { count: whole })
    return rest === 0 ? m : t("audio.transcribeCost.minutesAndSeconds", { minutes: m, seconds: t("audio.transcribeCost.seconds", { count: rest }) })
  }
  const minutes = audioMinutes(ms)
  if (minutes < 60) return t("audio.transcribeCost.minutes", { count: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const h = t("audio.transcribeCost.hours", { count: hours })
  return rest === 0 ? h : t("audio.transcribeCost.hoursAndMinutes", { hours: h, minutes: t("audio.transcribeCost.minutes", { count: rest }) })
}

/** "4 minutes", "10 seconds": a rounded run length. */
export function runLength(t: T, seconds: number): string {
  const r = roundedDuration(seconds)
  return "minutes" in r
    ? t("audio.transcribeCost.minutes", { count: r.minutes })
    : t("audio.transcribeCost.seconds", { count: r.seconds })
}

export function modelName(t: T, cost: TranscriptionCost): string {
  return cost.onDevice ? t("audio.transcribeCost.onDeviceModel") : t(MODEL_KEY[cost.model])
}

/** The source language's name in the reader's language, or null. */
export function languageName(locale: string, tag: string | undefined): string | null {
  if (!tag) return null
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? null
  } catch {
    return null
  }
}

export function TranscriptionCostLines({ cost, languageTag, credits, testId }: {
  cost: TranscriptionCost
  languageTag?: string
  /** The Credits line, when it could be worked out (hosted runs only). */
  credits?: string | null
  testId?: string
}) {
  const t = useT()
  const { locale } = useI18n()
  const [limitOpen, toggleLimit] = useInfoOpen()
  const limitId = useId()
  const language = languageName(locale, languageTag)
  const audio = cost.recordings > 1
    ? t("audio.transcribeCost.inRecordings", { length: audioLength(t, cost.audioMs), count: cost.recordings })
    : audioLength(t, cost.audioMs)
  const requests = cost.onDevice
    ? t("audio.transcribeCost.onDeviceRequests")
    : cost.requests === 1
      ? "1"
      : t(cost.windowSec >= 60 ? "audio.transcribeCost.requestsEachMinute" : "audio.transcribeCost.requestsTwoEachMinute", { count: cost.requests })
  const model = cost.onDevice
    ? t("audio.transcribeCost.onDeviceModel")
    : cost.automatic
      ? language
        ? t("audio.transcribeCost.modelAuto", { model: modelName(t, cost), language })
        : t("audio.transcribeCost.modelAutoNoLanguage", { model: modelName(t, cost) })
      : t("audio.transcribeCost.modelChosen", { model: modelName(t, cost) })
  const time = cost.onDevice ? t("audio.transcribeCost.onDeviceTime") : (
    <span className="flex flex-col">
      <span className="inline-flex items-center gap-1">
        {t(cost.waitsAtLimit ? "audio.transcribeCost.aboutWithWait" : "audio.transcribeCost.about", { length: runLength(t, cost.seconds) })}
        {cost.waitsAtLimit && <InfoToggle open={limitOpen} onToggle={toggleLimit}
          label={t("audio.transcribeCost.limitInfoLabel")} controls={limitId} />}
      </span>
      {cost.waitsAtLimit && <InfoReveal open={limitOpen} id={limitId} className="text-xs text-muted-foreground">
        {t("audio.transcribeCost.limitInfo")}
      </InfoReveal>}
    </span>
  )
  const rows: Array<[string, React.ReactNode]> = [
    [t("audio.transcribeCost.audioLabel"), audio],
    [t("audio.transcribeCost.requestsLabel"), requests],
    [t("audio.transcribeCost.timeLabel"), time],
    [t("audio.transcribeCost.modelLabel"), model],
  ]
  if (cost.onDevice) rows.push([t("audio.transcribeCost.creditsLabel"), t("audio.transcribeCost.onDevice")])
  else if (credits) rows.push([t("audio.transcribeCost.creditsLabel"), credits])
  return (
    <dl data-testid={testId} className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[8.25rem_1fr] items-start gap-3">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
