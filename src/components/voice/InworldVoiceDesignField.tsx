// Inworld Voice Design — describe a voice, generate up to three previews, pick one.
// Publish happens on Create/Save in NewVoiceModal, not here.

import { useEffect, useRef, useState } from "react"
import { ExternalLink, Pause, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { InworldDesignLocaleFields } from "@/components/voice/InworldDesignLocaleFields"
import { InworldDesignProfileFields } from "@/components/voice/InworldDesignProfileFields"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
import { useT } from "@/lib/i18n/I18nProvider"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { getCellAudioStreamUrl, parseFrontierAudioUrl } from "@/lib/audio/upload"
import {
  INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
  INWORLD_DESIGN_PREVIEW_TEXT_MAX,
  INWORLD_DESIGN_PREVIEW_TEXT_MIN,
  INWORLD_DESIGN_PROMPT_MAX,
  INWORLD_DESIGN_PROMPT_MIN,
  INWORLD_DESIGN_PROMPT_MODE_VERBATIM,
  INWORLD_DESIGN_SAMPLE_COUNT,
  INWORLD_VOICE_DESIGN_DOCS_URL,
  blankInworldVoiceProfile,
  initialInworldDesignMode,
  inworldVoiceProfileHasValue,
  looksLikeInworldVoiceProfile,
  parseInworldVoiceProfile,
  previewAudioSrc,
  serializeInworldVoiceProfile,
  type InworldDesignMode,
  type InworldDesignProfileKey,
  type InworldVoiceProfileExtra,
} from "@/lib/audio/inworld-voice-design"
import { designInworldVoice, synthesizeCellTts, type InworldDesignedPreview } from "@/lib/sync/tts"
import { cn } from "@/lib/utils"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Voice } from "@/lib/parsers/types"

export type InworldDesignSelection = {
  voiceId: string
  unpublished: boolean
}

export function InworldVoiceDesignField({
  prompt,
  onPromptChange,
  selection,
  onSelectionChange,
  existingVoiceId,
  language,
  onLanguageChange,
  projectId,
  fileId,
  session,
  speakingRate,
  deliveryMode,
  audioQuality,
}: {
  prompt: string
  onPromptChange: (prompt: string) => void
  selection: InworldDesignSelection | null
  onSelectionChange: (selection: InworldDesignSelection | null) => void
  existingVoiceId?: string
  language?: string
  onLanguageChange: (language: string) => void
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  speakingRate?: Voice["speakingRate"]
  deliveryMode?: Voice["deliveryMode"]
  audioQuality?: Voice["audioQuality"]
}) {
  const t = useT()
  const [mode, setMode] = useState<InworldDesignMode>(() => initialInworldDesignMode(prompt))
  const [profile, setProfile] = useState(() => parseInworldVoiceProfile(prompt).profile)
  const [extras, setExtras] = useState<InworldVoiceProfileExtra[]>(
    () => parseInworldVoiceProfile(prompt).extras,
  )
  const [previews, setPreviews] = useState<InworldDesignedPreview[]>([])
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [loadingSaved, setLoadingSaved] = useState(false)
  const [script, setScript] = useState(INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const aliveRef = useRef(true)
  const savedSrcRef = useRef<string | null>(null)
  const structuredPrompt = serializeInworldVoiceProfile(profile, extras)
  const designPrompt = mode === "structured" ? structuredPrompt.trim() : prompt.trim()
  const trimmed = prompt.trim()
  const trimmedScript = script.trim()
  const tooShort = mode === "freeform" && trimmed.length > 0 && trimmed.length < INWORLD_DESIGN_PROMPT_MIN
  const scriptTooShort = trimmedScript.length > 0 && trimmedScript.length < INWORLD_DESIGN_PREVIEW_TEXT_MIN
  const promptReady = mode === "structured"
    ? inworldVoiceProfileHasValue(profile, extras)
      && structuredPrompt.length >= INWORLD_DESIGN_PROMPT_MIN
      && structuredPrompt.length <= INWORLD_DESIGN_PROMPT_MAX
    : trimmed.length >= INWORLD_DESIGN_PROMPT_MIN
      && trimmed.length <= INWORLD_DESIGN_PROMPT_MAX
  const canGenerate = promptReady
    && trimmedScript.length >= INWORLD_DESIGN_PREVIEW_TEXT_MIN
    && trimmedScript.length <= INWORLD_DESIGN_PREVIEW_TEXT_MAX
    && !generating

  const applyProfile = (next: typeof profile, nextExtras: InworldVoiceProfileExtra[]) => {
    setProfile(next)
    setExtras(nextExtras)
    onPromptChange(serializeInworldVoiceProfile(next, nextExtras))
  }

  const selectMode = (next: InworldDesignMode) => {
    if (next === "structured" && looksLikeInworldVoiceProfile(prompt)) {
      const parsed = parseInworldVoiceProfile(prompt)
      setProfile(parsed.profile)
      setExtras(parsed.extras)
    }
    setMode(next)
  }

  const canPlaySaved = Boolean(existingVoiceId)
    && trimmedScript.length >= INWORLD_DESIGN_PREVIEW_TEXT_MIN
    && trimmedScript.length <= INWORLD_DESIGN_PREVIEW_TEXT_MAX
    && !generating

  useEffect(() => {
    savedSrcRef.current = null
  }, [trimmedScript, language, speakingRate, deliveryMode, audioQuality, existingVoiceId])

  const haltAudio = (audio: HTMLAudioElement | null) => {
    if (!audio) return
    audio.pause()
    audio.onended = null
    audio.removeAttribute("src")
    audio.src = ""
    try {
      audio.load()
    } catch {
      /* stubs / environments without a media pipeline */
    }
  }

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      haltAudio(audioRef.current)
      audioRef.current = null
    }
  }, [])

  const stopPreview = () => {
    haltAudio(audioRef.current)
    audioRef.current = null
    setPlayingId(null)
  }

  const generate = async () => {
    if (!canGenerate) return
    if (!projectId || !fileId || !session) {
      setError(t("audio.newVoice.errorDesignNoProject"))
      return
    }
    stopPreview()
    setGenerating(true)
    setError(null)
    try {
      const rows = await designInworldVoice(
        {
          projectId,
          fileId,
          designPrompt,
          previewText: trimmedScript,
          numberOfSamples: INWORLD_DESIGN_SAMPLE_COUNT,
          ...(mode === "structured" ? { designPromptMode: INWORLD_DESIGN_PROMPT_MODE_VERBATIM } : {}),
          ...(language ? { language } : {}),
        },
        audioSyncTokenFetcherForSession(session),
      )
      setPreviews(rows)
      const first = rows[0]
      if (first) {
        onSelectionChange({ voiceId: first.voiceId, unpublished: true })
        playPreview(first)
      } else {
        onSelectionChange(null)
      }
    } catch (err) {
      setPreviews([])
      onSelectionChange(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const playSrc = (src: string, id: string) => {
    const audio = audioRef.current ?? new Audio()
    audioRef.current = audio
    audio.onended = () => {
      if (audioRef.current === audio) setPlayingId(null)
    }
    audio.src = src
    void audio.play().then(() => {
      if (!aliveRef.current || audioRef.current !== audio) {
        haltAudio(audio)
        return
      }
      setPlayingId(id)
    }).catch(() => {
      if (aliveRef.current && audioRef.current === audio) setPlayingId(null)
    })
  }

  const playPreview = (preview: InworldDesignedPreview) => {
    playSrc(previewAudioSrc(preview.previewAudio), preview.voiceId)
  }

  const togglePlay = (preview: InworldDesignedPreview) => {
    if (playingId === preview.voiceId) {
      stopPreview()
      return
    }
    onSelectionChange({ voiceId: preview.voiceId, unpublished: true })
    playPreview(preview)
  }

  const toggleSaved = async () => {
    if (!existingVoiceId) return
    if (playingId === existingVoiceId) {
      stopPreview()
      return
    }
    if (loadingSaved || !canPlaySaved) return
    if (!projectId || !fileId || !session) {
      setError(t("audio.newVoice.errorDesignNoProject"))
      return
    }
    setError(null)
    if (savedSrcRef.current) {
      playSrc(savedSrcRef.current, existingVoiceId)
      return
    }
    setLoadingSaved(true)
    try {
      const getSyncToken = audioSyncTokenFetcherForSession(session)
      const result = await synthesizeCellTts(
        {
          projectId,
          fileId,
          text: trimmedScript,
          voiceId: existingVoiceId,
          ...(language ? { language } : {}),
          ...(speakingRate !== undefined ? { speakingRate } : {}),
          ...(deliveryMode ? { deliveryMode } : {}),
          ...(audioQuality ? { audioQuality } : {}),
        },
        getSyncToken,
      )
      if (!aliveRef.current) return
      const parsed = parseFrontierAudioUrl(result.url)
      if (!parsed) throw new Error("Saved voice preview is missing an audio pointer.")
      const src = await getCellAudioStreamUrl({
        projectId,
        fileId,
        audioId: parsed.audioId,
        ext: parsed.ext,
        getSyncToken,
      })
      if (!aliveRef.current) return
      if (!src) throw new Error(t("audio.newVoice.errorDesignNoProject"))
      savedSrcRef.current = src
      playSrc(src, existingVoiceId)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoadingSaved(false)
    }
  }

  return (
    <div className="space-y-3">
      <Tabs
        value={mode}
        onValueChange={(value) => {
          if (value === "freeform" || value === "structured") selectMode(value)
        }}
        className="gap-0"
      >
        <TabsList className="w-full" aria-label={t("audio.newVoice.designModeGroupLabel")}>
          <TabsTrigger value="freeform">{t("audio.newVoice.designModeFreeform")}</TabsTrigger>
          <TabsTrigger value="structured">{t("audio.newVoice.designModeStructured")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "freeform" ? (
        <Field className="gap-2.5">
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="inworld-design-prompt">{t("audio.newVoice.describeLabel")}</FieldLabel>
            <p className="text-[11px] text-muted-foreground">
              {t("audio.newVoice.designPromptHint")}{" "}
              <a
                href={INWORLD_VOICE_DESIGN_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
              >
                {t("audio.newVoice.designDocsLink")}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </p>
          </div>
          <Textarea
            id="inworld-design-prompt"
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            rows={3}
            maxLength={INWORLD_DESIGN_PROMPT_MAX}
            placeholder={t("audio.newVoice.designPromptPlaceholder")}
          />
          {tooShort && (
            <p className="text-[11px] text-destructive">{t("audio.newVoice.designPromptTooShort")}</p>
          )}
        </Field>
      ) : (
        <InworldDesignProfileFields
          profile={profile}
          onChange={(key: InworldDesignProfileKey, value: string) => {
            applyProfile({ ...profile, [key]: value }, extras)
          }}
          onClear={() => {
            setProfile(blankInworldVoiceProfile())
            setExtras([])
            onPromptChange("")
          }}
        />
      )}

      <Field>
        <div className="flex items-center gap-1.5">
          <FieldLabel htmlFor="inworld-design-script">{t("audio.newVoice.designScriptLabel")}</FieldLabel>
          <VoiceInfoTip
            content={t("audio.newVoice.designScriptHint")}
            label={t("audio.newVoice.designScriptHelpAria")}
          />
        </div>
        <Textarea
          id="inworld-design-script"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={3}
          maxLength={INWORLD_DESIGN_PREVIEW_TEXT_MAX}
        />
        {scriptTooShort && (
          <p className="text-[11px] text-destructive">{t("audio.newVoice.designScriptTooShort")}</p>
        )}
      </Field>

      <InworldDesignLocaleFields
        language={language}
        onLanguageChange={onLanguageChange}
        projectId={projectId}
        fileId={fileId}
        session={session}
      />

      <Button type="button" variant="outline" className="w-full" disabled={!canGenerate} onClick={() => void generate()}>
        {generating ? (
          <>
            <Spinner className="size-3" />
            {t("audio.newVoice.designGenerating")}
          </>
        ) : (
          t("audio.newVoice.designGenerate")
        )}
      </Button>

      {error && (
        <p className="select-text cursor-text break-words text-xs text-destructive" role="alert">{error}</p>
      )}

      {existingVoiceId && previews.length === 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-primary bg-primary/8 p-1">
            <span className="min-w-0 flex-1 truncate px-2 text-sm">
              {t("audio.newVoice.designSavedLabel")}
            </span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              disabled={loadingSaved || (!canPlaySaved && playingId !== existingVoiceId)}
              aria-label={playingId === existingVoiceId
                ? t("audio.newVoice.designStopSaved")
                : t("audio.newVoice.designPlaySaved")}
              onClick={() => void toggleSaved()}
            >
              {loadingSaved ? <Spinner className="size-3.5" /> : playingId === existingVoiceId ? <Pause /> : <Play />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("audio.newVoice.designExistingHint")}</p>
        </div>
      )}

      {previews.length > 0 && (
        <RadioGroup
          value={selection?.voiceId ?? ""}
          onValueChange={(voiceId) => {
            if (typeof voiceId !== "string" || !voiceId) return
            const preview = previews.find((row) => row.voiceId === voiceId)
            if (!preview) return
            onSelectionChange({ voiceId, unpublished: true })
            playPreview(preview)
          }}
          aria-label={t("audio.newVoice.designSelectPreview")}
          className="gap-1.5"
        >
          {previews.map((preview, index) => {
            const n = index + 1
            const selected = selection?.voiceId === preview.voiceId
            const playing = playingId === preview.voiceId
            return (
              <div
                key={preview.voiceId}
                className={cn(
                  "flex items-center gap-1 rounded-lg border p-1",
                  selected ? "border-primary bg-primary/8" : "border-border",
                )}
              >
                <label className="flex min-w-0 flex-1 items-center gap-2.5 px-2 text-sm">
                  <RadioGroupItem value={preview.voiceId} />
                  <span className="min-w-0 flex-1 truncate">
                    {t("audio.newVoice.designPreviewLabel", { n })}
                  </span>
                </label>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="relative z-10"
                  aria-label={playing
                    ? t("audio.newVoice.designStopPreview", { n })
                    : t("audio.newVoice.designPlayPreview", { n })}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    togglePlay(preview)
                  }}
                >
                  {playing ? <Pause /> : <Play />}
                </Button>
              </div>
            )
          })}
        </RadioGroup>
      )}
    </div>
  )
}
