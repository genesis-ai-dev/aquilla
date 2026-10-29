// Model + voice settings for an ElevenLabs voice (AQU-2299): the model select
// (Multilingual v2 / v3 / Flash v2.5, one line each on what it's for), a
// collapsed "Voice settings" section with the API's four sliders and the
// speaker-boost switch, and Preview — one short sample line synthesized with
// the current settings and played, without storing anything.
import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, Pause, Play } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
import { cn } from "@/lib/utils"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import {
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_SETTINGS,
  ELEVENLABS_MODELS,
  ELEVENLABS_SPEED_MAX,
  ELEVENLABS_SPEED_MIN,
  elevenLabsLanguageCode,
} from "@/lib/audio/elevenlabs/settings"
import { ELEVENLABS_PROJECT_SCOPE_FILE_ID, previewElevenLabsTts } from "@/lib/sync/elevenlabs"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ElevenLabsVoiceSettings } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { isDefaultElevenLabsSettings } from "./helpers"

type SliderKey = "stability" | "similarityBoost" | "style" | "speed"

const SLIDERS: readonly { key: SliderKey; labelKey: MessageKey; hintKey: MessageKey; min: number; max: number; step: number }[] = [
  { key: "stability", labelKey: "audio.elevenLabs.stability", hintKey: "audio.elevenLabs.stabilityHint", min: 0, max: 1, step: 0.05 },
  { key: "similarityBoost", labelKey: "audio.elevenLabs.similarity", hintKey: "audio.elevenLabs.similarityHint", min: 0, max: 1, step: 0.05 },
  { key: "style", labelKey: "audio.elevenLabs.style", hintKey: "audio.elevenLabs.styleHint", min: 0, max: 1, step: 0.05 },
  { key: "speed", labelKey: "audio.elevenLabs.speed", hintKey: "audio.elevenLabs.speedHint", min: ELEVENLABS_SPEED_MIN, max: ELEVENLABS_SPEED_MAX, step: 0.05 },
]

const formatValue = (key: SliderKey, v: number) => (key === "speed" ? `${v.toFixed(2)}×` : `${Math.round(v * 100)}%`)

export interface ElevenLabsVoiceTuningProps {
  modelId?: string
  settings: ElevenLabsVoiceSettings
  onModelChange: (modelId: string) => void
  onSettingsChange: (settings: ElevenLabsVoiceSettings) => void
  /** Preview needs a picked voice and a project to authorize against. */
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
  const setOne = (key: SliderKey, value: number) => onSettingsChange({ ...settings, [key]: value })

  // ── Preview ──
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
    <div className="space-y-3">
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

      <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border">
        <div className="flex items-center gap-2 px-3 py-2">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-sm font-medium outline-none focus-visible:underline">
            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
            {t("audio.elevenLabs.settingsLabel")}
          </CollapsibleTrigger>
          {!isDefaultElevenLabsSettings(settings) && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => onSettingsChange({ ...DEFAULT_ELEVENLABS_SETTINGS })}
            >
              {t("audio.elevenLabs.resetSettings")}
            </button>
          )}
        </div>
        <CollapsibleContent className="space-y-3.5 border-t px-3 py-3">
          {SLIDERS.map((s) => (
            <div key={s.key} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <span className="text-xs font-medium">{t(s.labelKey)}</span>
                  <VoiceInfoTip label={t("audio.elevenLabs.settingHelpAriaLabel", { setting: t(s.labelKey) })} content={t(s.hintKey)} />
                </div>
                <Badge variant="outline" className="bg-muted tabular-nums">{formatValue(s.key, settings[s.key])}</Badge>
              </div>
              <Slider
                min={s.min}
                max={s.max}
                step={s.step}
                value={[settings[s.key]]}
                onValueChange={(next) => {
                  const value = Array.isArray(next) ? next[0] : next
                  if (typeof value === "number") setOne(s.key, Math.round(value * 100) / 100)
                }}
                aria-label={t(s.labelKey)}
              />
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <span className="text-xs font-medium">{t("audio.elevenLabs.speakerBoost")}</span>
              <VoiceInfoTip
                label={t("audio.elevenLabs.settingHelpAriaLabel", { setting: t("audio.elevenLabs.speakerBoost") })}
                content={t("audio.elevenLabs.speakerBoostHint")}
              />
            </div>
            <Switch
              size="sm"
              checked={settings.speakerBoost}
              onCheckedChange={(checked) => onSettingsChange({ ...settings, speakerBoost: checked === true })}
              aria-label={t("audio.elevenLabs.speakerBoost")}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!canPreview} onClick={() => void preview()}>
          {previewState === "loading" ? <Spinner className="size-3" /> : previewState === "playing" ? <Pause /> : <Play />}
          {previewState === "playing" ? t("audio.elevenLabs.stopPreview") : t("common.preview")}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {canPreview ? t("audio.elevenLabs.previewHint") : t("audio.elevenLabs.previewNeedsVoice")}
        </span>
      </div>
      {previewError && <p className="select-text break-words text-xs text-destructive" role="alert">{previewError}</p>}
    </div>
  )
}
