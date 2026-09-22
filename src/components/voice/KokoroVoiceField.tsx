import { useEffect, useState } from "react"
import { Pause, Play } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  kokoroSpeaksEnglishOnlyFor,
  kokoroVoiceGroupsForLanguage,
  type KokoroBundledVoice,
} from "@/lib/audio/kokoro-languages"
import {
  stopKokoroPreview,
  subscribeKokoroPreview,
  toggleKokoroPreview,
} from "@/lib/audio/kokoro-preview"
import type { MessageKey } from "@/lib/i18n/messages/en"

function KokoroPreviewButton({
  voiceId,
  name,
  playingId,
}: {
  voiceId: string
  name: string
  playingId: string | null
}) {
  const t = useT()
  const playing = playingId === voiceId
  return (
    <button
      type="button"
      aria-label={
        playing
          ? t("audio.newVoice.kokoroStopSample", { name })
          : t("audio.newVoice.kokoroPlaySample", { name })
      }
      className="pointer-events-auto relative z-10 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground"
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        toggleKokoroPreview(voiceId)
      }}
    >
      {playing ? (
        <Pause className="size-3.5" />
      ) : (
        <Play className="size-3.5 translate-x-px" />
      )}
    </button>
  )
}

/** Kokoro voiceName is a bundled speaker id. Grouped by accent, with the
 *  project's target language listed first. Each row can play a short sample. */
export function KokoroVoiceField({
  value,
  targetLanguage,
  onChange,
}: {
  value: string
  targetLanguage?: string
  onChange: (v: string) => void
}) {
  const t = useT()
  const [playingId, setPlayingId] = useState<string | null>(null)
  useEffect(() => {
    const unsub = subscribeKokoroPreview(setPlayingId)
    return () => {
      unsub()
      stopKokoroPreview()
    }
  }, [])

  const groups = kokoroVoiceGroupsForLanguage(targetLanguage)
  const catalog = groups.flatMap((g) => g.voices)
  const extraId = value && !catalog.some((v) => v.id === value) ? value : null
  const genderKey = (gender: KokoroBundledVoice["gender"]): MessageKey =>
    gender === "male" ? "audio.newVoice.kokoroGenderMale" : "audio.newVoice.kokoroGenderFemale"
  const optionLabel = (voice: KokoroBundledVoice) => `${voice.name} · ${t(genderKey(voice.gender))}`
  const groupLabel = (prefix: "a" | "b") =>
    prefix === "b" ? t("audio.newVoice.kokoroGroupBritish") : t("audio.newVoice.kokoroGroupAmerican")
  const englishOnly = kokoroSpeaksEnglishOnlyFor(targetLanguage)
  const items = [
    ...(extraId ? [{ value: extraId, label: extraId }] : []),
    ...catalog.map((v) => ({ value: v.id, label: optionLabel(v) })),
  ]

  return (
    <Field>
      <FieldLabel htmlFor="voice-kokoro">{t("audio.newVoice.kokoroLabel")}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(v) => onChange(v ?? "")}
      >
        <SelectTrigger id="voice-kokoro">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          {extraId && (
            <SelectGroup>
              <SelectItem value={extraId}>{extraId}</SelectItem>
            </SelectGroup>
          )}
          {groups.map((group) => (
            <SelectGroup key={group.prefix}>
              <SelectLabel>{groupLabel(group.prefix)}</SelectLabel>
              {group.voices.map((voice) => (
                <SelectItem
                  key={voice.id}
                  value={voice.id}
                  leading={
                    <KokoroPreviewButton
                      voiceId={voice.id}
                      name={voice.name}
                      playingId={playingId}
                    />
                  }
                >
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span>{voice.name}</span>
                    <span className="text-xs text-muted-foreground">{t(genderKey(voice.gender))}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {englishOnly && (
        <FieldDescription>{t("audio.newVoice.kokoroEnglishOnlyHint")}</FieldDescription>
      )}
    </Field>
  )
}
