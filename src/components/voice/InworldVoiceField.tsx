import { useMemo } from "react"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { VoiceLanguageBadge } from "@/components/voice/VoiceLanguageBadge"
import { useT } from "@/lib/i18n/I18nProvider"
import { DEFAULT_INWORLD_VOICE, isInworldVoiceName } from "@/lib/audio/tts-providers"
import {
  showVoiceLanguageBadge,
  useInworldCatalogVoices,
  type InworldCatalogVoice,
} from "@/lib/audio/inworld-voices"
import type { FrontierSession } from "@/lib/frontier/types"

export function InworldVoiceField({
  value,
  onChange,
  targetLanguages,
  projectId,
  fileId,
  session,
}: {
  value: string | undefined
  onChange: (voiceId: string, language?: string) => void
  targetLanguages: readonly string[]
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
}) {
  const t = useT()
  const { voices, status, attempted } = useInworldCatalogVoices({
    enabled: true,
    projectId,
    fileId,
    session,
    languages: targetLanguages,
  })
  const showBadge = showVoiceLanguageBadge(targetLanguages)
  const groups = useMemo(() => groupCatalogByLanguage(voices), [voices])
  const selected = voices.find((v) => v.voiceId === value)
  const selectValue = selected?.voiceId
    ?? (value && isInworldVoiceName(value) ? value : voices[0]?.voiceId ?? DEFAULT_INWORLD_VOICE)

  return (
    <Field>
      <FieldLabel htmlFor="inworld-voice">{t("audio.newVoice.inworldVoiceLabel")}</FieldLabel>
      <Select
        value={selectValue}
        onValueChange={(next) => {
          const id = next || DEFAULT_INWORLD_VOICE
          const match = voices.find((v) => v.voiceId === id)
          onChange(id, match?.language)
        }}
      >
        <SelectTrigger id="inworld-voice" className="h-10">
          <SelectValue>
            {selected ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{selected.displayName}</span>
                {showBadge ? <VoiceLanguageBadge language={selected.language} /> : null}
              </span>
            ) : selectValue}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {status === "loading" && (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {t("audio.newVoice.inworldVoiceLoading")}
            </div>
          )}
          {groups.map(([language, rows]) => (
            <SelectGroup key={language}>
              {groups.length > 1 && <SelectLabel>{language}</SelectLabel>}
              {rows.map((row) => (
                <SelectItem key={row.voiceId} value={row.voiceId}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{row.displayName}</span>
                    {showBadge ? <VoiceLanguageBadge language={row.language} /> : null}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {status === "fallback" && attempted && (
        <p className="text-[11px] text-muted-foreground">{t("audio.newVoice.inworldVoiceUnavailable")}</p>
      )}
    </Field>
  )
}

function groupCatalogByLanguage(voices: InworldCatalogVoice[]): [string, InworldCatalogVoice[]][] {
  const map = new Map<string, InworldCatalogVoice[]>()
  for (const voice of voices) {
    const key = voice.language || "und"
    const list = map.get(key) ?? []
    list.push(voice)
    map.set(key, list)
  }
  return [...map.entries()]
}
