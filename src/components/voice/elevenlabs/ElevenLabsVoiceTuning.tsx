// "Adjust" for an ElevenLabs voice (AQU-2299): a quiet disclosure, collapsed by
// default, holding only the model, Stability and Speed, plus "Hear it" — one
// short sample line synthesized with the current settings and played, without
// storing anything. Similarity, style and speaker boost keep their defaults
// (DEFAULT_ELEVENLABS_SETTINGS) and are not shown.
import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, Pause, Play } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import {
  DEFAULT_ELEVENLABS_MODEL,
  ELEVENLABS_MODELS,
  ELEVENLABS_SPEED_MAX,
  ELEVENLABS_SPEED_MIN,
  elevenLabsLanguageCode,
} from "@/lib/audio/elevenlabs/settings"
import { ELEVENLABS_PROJECT_SCOPE_FILE_ID, previewElevenLabsTts } from "@/lib/sync/elevenlabs"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ElevenLabsVoiceSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

type SliderKey = "stability" | "speed"

const SLIDERS: readonly { key: SliderKey; labelKey: MessageKey; min: number; max: number; step: number }[] = [
  { key: "stability", labelKey: "audio.elevenLabs.stability", min: 0, max: 1, step: 0.05 },
  { key: "speed", labelKey: "audio.elevenLabs.speed", min: ELEVENLABS_SPEED_MIN, max: ELEVENLABS_SPEED_MAX, step: 0.05 },
]

const formatValue = (key: SliderKey, v: number) => (key === "speed" ? `${v.toFixed(2)}×` : `${Math.round(v * 100)}%`)

export interface ElevenLabsVoiceTuningProps {
  modelId?: string
  settings: ElevenLabsVoiceSettings
  onModelChange: (modelId: string) => void
  onSettingsChange: (settings: ElevenLabsVoiceSettings) => void
  /** Hear it needs a picked voice and a project to authorize against. */
  voiceId?: string
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  /** The voice's lane language, sent as `language_code` where the model takes one. */
  language?: string
}

export function ElevenLabsVoiceTuning({
  modelId, settings, onModelChange, onSettingsChange, voiceId, projectId, fileId, session, language,
}: ElevenLabsVoiceTuningProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const model = modelId ?? DEFAULT_ELEVENLABS_MODEL

  // ── Hear it ──
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "playing">("idle")
  const [previewError, setPreviewError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const stop = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
    setPreviewState("idle")
  }, [])
  useEffect(() => () => stop(), [stop])
  const canPreview = Boolean(voiceId && projectId && session)
  const preview = useCallback(async () => {
    if (previewState !== "idle") {
      stop()
      return
    }
    if (!voiceId || !projectId || !session) return
    setPreviewError(null)
    setPreviewState("loading")
    try {
      const languageCode = elevenLabsLanguageCode(language)
      const blob = await previewElevenLabsTts({
        projectId,
        fileId: fileId || ELEVENLABS_PROJECT_SCOPE_FILE_ID,
        text: t("audio.elevenLabs.previewSample"),
        voiceId,
        modelId: model,
        voiceSettings: settings,
        ...(languageCode ? { languageCode } : {}),
      }, audioSyncTokenFetcherForSession(session))
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => stop()
      setPreviewState("playing")
      await audio.play().catch(() => stop())
    } catch (e) {
      setPreviewError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)
      setPreviewState("idle")
    }
  }, [previewState, stop, voiceId, projectId, session, language, fileId, t, model, settings])

  const modelItems = ELEVENLABS_MODELS.map((m) => ({ value: m.id, label: m.name }))

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="-ms-2 text-muted-foreground"
        aria-expanded={open}
        aria-controls="elevenlabs-adjust"
        onClick={() => setOpen((o) => !o)}
      >
        {t("audio.elevenLabs.adjust")}
        <ChevronDown className={cn("transition-transform", !open && "-rotate-90")} aria-hidden />
      </Button>
      {open && <div id="elevenlabs-adjust" className="mt-2 space-y-3.5 rounded-xl border p-3">
        <Field>
          <FieldLabel htmlFor="elevenlabs-model">{t("audio.elevenLabs.modelLabel")}</FieldLabel>
          <Select items={modelItems} value={model} onValueChange={(v) => { if (v) onModelChange(v) }}>
            <SelectTrigger id="elevenlabs-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {ELEVENLABS_MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="flex flex-col">
                      <span>{m.name}</span>
                      <span className="text-[11px] text-muted-foreground">{t(m.descriptionKey)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {SLIDERS.map((s) => (
          <div key={s.key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">{t(s.labelKey)}</span>
              <span className="tabular-nums text-muted-foreground">{formatValue(s.key, settings[s.key])}</span>
            </div>
            <Slider
              min={s.min}
              max={s.max}
              step={s.step}
              value={[settings[s.key]]}
              onValueChange={(next) => {
                const value = Array.isArray(next) ? next[0] : next
                if (typeof value === "number") onSettingsChange({ ...settings, [s.key]: Math.round(value * 100) / 100 })
              }}
              aria-label={t(s.labelKey)}
            />
          </div>
        ))}

        <Button type="button" variant="ghost" size="xs" className="-ms-2" disabled={!canPreview} onClick={() => void preview()}>
          {previewState === "loading" ? <Spinner className="size-3" /> : previewState === "playing" ? <Pause /> : <Play />}
          {previewState === "playing" ? t("audio.elevenLabs.stopPreview") : t("audio.elevenLabs.hearIt")}
        </Button>
        {previewError && <p className="select-text break-words text-xs text-destructive" role="alert">{previewError}</p>}
      </div>}
    </div>
  )
}
