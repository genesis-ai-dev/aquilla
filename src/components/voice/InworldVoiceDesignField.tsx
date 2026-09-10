// Inworld Voice Design — describe a voice, generate up to three previews, pick one.
// Publish happens on Create/Save in NewVoiceModal, not here.

import { useEffect, useRef, useState } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"
import { ExternalLink, Pause, Play, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { Textarea } from "@/components/ui/textarea"
import { InworldDesignLocaleFields } from "@/components/voice/InworldDesignLocaleFields"
import { InworldDesignPresetChips } from "@/components/voice/InworldDesignPresetChips"
import { VoiceInfoTip } from "@/components/voice/VoiceInfoTip"
import { isFieldInvalid } from "@/lib/forms/field-state"
import { useSubmitError } from "@/lib/forms/submit-error"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { getCellAudioStreamUrl, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioMimeForExt } from "@/lib/audio/mime"
import { fetchVoiceReference } from "@/lib/audio/voice-clone"
import {
  INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
  INWORLD_DESIGN_PREVIEW_TEXT_MAX,
  INWORLD_DESIGN_PREVIEW_TEXT_MIN,
  INWORLD_DESIGN_PROMPT_MAX,
  INWORLD_DESIGN_PROMPT_MIN,
  INWORLD_DESIGN_PROMPT_MODE_VERBATIM,
  INWORLD_DESIGN_SAMPLE_COUNT,
  INWORLD_VOICE_DESIGN_DOCS_URL,
  blankStructuredDesignPrompt,
  initialInworldDesignMode,
  looksLikeInworldVoiceProfile,
  previewAudioSrc,
  structuredDesignPromptHasValue,
  type InworldDesignMode,
} from "@/lib/audio/inworld-voice-design"
import { designInworldVoice, synthesizeCellTts, type InworldDesignedPreview } from "@/lib/sync/tts"
import { cn } from "@/lib/utils"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Voice } from "@/lib/parsers/types"

function designPreviewSchema(t: TFunction) {
  return z.object({
    mode: z.enum(["freeform", "structured"]),
    prompt: z.string(),
    script: z.string(),
  }).superRefine((data, ctx) => {
    const prompt = data.prompt.trim()
    if (data.mode === "structured" && !structuredDesignPromptHasValue(data.prompt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: t("audio.newVoice.designStructuredEmpty"),
        path: ["prompt"],
      })
    } else if (prompt.length < INWORLD_DESIGN_PROMPT_MIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: t("audio.newVoice.designPromptTooShort"),
        path: ["prompt"],
      })
    }
    if (data.script.trim().length < INWORLD_DESIGN_PREVIEW_TEXT_MIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: t("audio.newVoice.designScriptTooShort"),
        path: ["script"],
      })
    }
  })
}

export type InworldDesignSelection = {
  voiceId: string
  unpublished: boolean
  previewAudio?: string
}

function unpublishedSelection(preview: InworldDesignedPreview): InworldDesignSelection {
  return { voiceId: preview.voiceId, unpublished: true, previewAudio: preview.previewAudio }
}

export function InworldVoiceDesignField({
  prompt,
  onPromptChange,
  selection,
  onSelectionChange,
  existingVoiceId,
  existingPreviewAudioId,
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
  existingPreviewAudioId?: string
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
  const savedProfile = looksLikeInworldVoiceProfile(prompt)
  const [freeformDraft, setFreeformDraft] = useState(() => (savedProfile ? "" : prompt))
  const [structuredDraft, setStructuredDraft] = useState(() =>
    savedProfile ? prompt : blankStructuredDesignPrompt(),
  )
  const [previews, setPreviews] = useState<InworldDesignedPreview[]>([])
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [loadingSaved, setLoadingSaved] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const aliveRef = useRef(true)
  const savedSrcRef = useRef<string | null>(null)
  const { submitError, setSubmitError, clearSubmitError } = useSubmitError()

  const form = useForm({
    defaultValues: {
      mode: initialInworldDesignMode(prompt),
      prompt,
      script: INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT,
    },
    validators: { onSubmit: designPreviewSchema(t) },
    onSubmit: async ({ value }) => {
      if (!projectId || !fileId || !session) {
        setSubmitError(t("audio.newVoice.errorDesignNoProject"))
        return
      }
      stopPreview()
      clearSubmitError()
      try {
        const rows = await designInworldVoice(
          {
            projectId,
            fileId,
            designPrompt: value.prompt.trim(),
            previewText: value.script.trim(),
            numberOfSamples: INWORLD_DESIGN_SAMPLE_COUNT,
            ...(value.mode === "structured" ? { designPromptMode: INWORLD_DESIGN_PROMPT_MODE_VERBATIM } : {}),
            ...(language ? { language } : {}),
          },
          audioSyncTokenFetcherForSession(session),
        )
        setPreviews(rows)
        const first = rows[0]
        if (first) {
          onSelectionChange(unpublishedSelection(first))
          playPreview(first)
        } else {
          onSelectionChange(null)
        }
      } catch (err) {
        setPreviews([])
        onSelectionChange(null)
        setSubmitError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  const selectMode = (next: InworldDesignMode) => {
    if (next === form.getFieldValue("mode")) return
    if (next === "structured") {
      const current = form.getFieldValue("prompt")
      const nextText = looksLikeInworldVoiceProfile(current)
        ? current
        : structuredDraft.trim().length > 0
          ? structuredDraft
          : blankStructuredDesignPrompt()
      setStructuredDraft(nextText)
      form.setFieldValue("prompt", nextText)
      onPromptChange(nextText)
    } else {
      form.setFieldValue("prompt", freeformDraft)
      onPromptChange(freeformDraft)
    }
    form.setFieldValue("mode", next)
  }

  const savedPlaybackKey = existingPreviewAudioId
    ?? `${existingVoiceId ?? ""}:${language ?? ""}:${speakingRate ?? ""}:${deliveryMode ?? ""}:${audioQuality ?? ""}`

  useEffect(() => {
    if (savedSrcRef.current?.startsWith("blob:")) URL.revokeObjectURL(savedSrcRef.current)
    savedSrcRef.current = null
  }, [savedPlaybackKey])

  const dropSavedSrc = () => {
    if (savedSrcRef.current?.startsWith("blob:")) URL.revokeObjectURL(savedSrcRef.current)
    savedSrcRef.current = null
  }

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
      if (savedSrcRef.current?.startsWith("blob:")) URL.revokeObjectURL(savedSrcRef.current)
      savedSrcRef.current = null
    }
  }, [])

  const stopPreview = () => {
    haltAudio(audioRef.current)
    audioRef.current = null
    setPlayingId(null)
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
    onSelectionChange(unpublishedSelection(preview))
    playPreview(preview)
  }

  const toggleSaved = async () => {
    if (!existingVoiceId) return
    if (playingId === existingVoiceId) {
      stopPreview()
      return
    }
    const script = form.getFieldValue("script").trim()
    const canPlaySaved = Boolean(existingPreviewAudioId)
      || (
        script.length >= INWORLD_DESIGN_PREVIEW_TEXT_MIN
        && script.length <= INWORLD_DESIGN_PREVIEW_TEXT_MAX
      )
    if (loadingSaved || !canPlaySaved) return
    if (!projectId || !fileId || !session) {
      setSubmitError(t("audio.newVoice.errorDesignNoProject"))
      return
    }
    clearSubmitError()
    if (savedSrcRef.current) {
      playSrc(savedSrcRef.current, existingVoiceId)
      return
    }
    setLoadingSaved(true)
    try {
      const getSyncToken = audioSyncTokenFetcherForSession(session)
      if (existingPreviewAudioId) {
        const bytes = await fetchVoiceReference({
          projectId,
          fileId,
          referenceAudioId: existingPreviewAudioId,
          getSyncToken,
        })
        if (!aliveRef.current) return
        const ext = existingPreviewAudioId.slice(existingPreviewAudioId.lastIndexOf(".") + 1)
        const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: audioMimeForExt(ext) }))
        if (savedSrcRef.current?.startsWith("blob:")) URL.revokeObjectURL(savedSrcRef.current)
        savedSrcRef.current = src
        playSrc(src, existingVoiceId)
        return
      }
      const result = await synthesizeCellTts(
        {
          projectId,
          fileId,
          text: script,
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
      if (aliveRef.current) setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoadingSaved(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-5 space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Subscribe
        selector={(state) => state.values.mode}
        children={(mode) => {
          const promptFieldId = mode === "freeform" ? "inworld-design-prompt" : "inworld-design-profile"
          return (
            <Field className="gap-2.5">
              <div className={cn("flex flex-col gap-1", mode === "structured" && "min-w-0")}>
                <FieldLabel htmlFor={promptFieldId}>
                  {mode === "freeform"
                    ? t("audio.newVoice.describeLabel")
                    : t("audio.newVoice.designStructuredLabel")}
                </FieldLabel>
                <p className="text-[11px] text-muted-foreground">
                  {mode === "freeform"
                    ? t("audio.newVoice.designPromptHint")
                    : t("audio.newVoice.designStructuredHint")}{" "}
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

              <Tabs
                value={mode}
                onValueChange={(value) => {
                  if (value === "freeform" || value === "structured") selectMode(value)
                }}
                className="gap-0"
              >
                <TabsList aria-label={t("audio.newVoice.designModeGroupLabel")}>
                  <AppTooltip content={t("audio.newVoice.designModeFreeformHint")} className="max-w-xs">
                    <TabsTrigger value="freeform">{t("audio.newVoice.designModeFreeform")}</TabsTrigger>
                  </AppTooltip>
                  <AppTooltip content={t("audio.newVoice.designModeStructuredHint")} className="max-w-xs">
                    <TabsTrigger value="structured">{t("audio.newVoice.designModeStructured")}</TabsTrigger>
                  </AppTooltip>
                </TabsList>
              </Tabs>

              <form.Field
                name="prompt"
                children={(field) => {
                  const invalid = isFieldInvalid(field)
                  const setPrompt = (next: string) => {
                    field.handleChange(next)
                    onPromptChange(next)
                    if (mode === "freeform") setFreeformDraft(next)
                    else setStructuredDraft(next)
                  }
                  return (
                    <Field data-invalid={invalid} className="gap-2.5">
                      {mode === "freeform" ? (
                        <>
                          <Textarea
                            id="inworld-design-prompt"
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => setPrompt(e.target.value)}
                            rows={3}
                            maxLength={INWORLD_DESIGN_PROMPT_MAX}
                            placeholder={t("audio.newVoice.designPromptPlaceholder")}
                            aria-invalid={invalid}
                          />
                          <InworldDesignPresetChips
                            mode="freeform"
                            value={field.state.value}
                            onSelect={setPrompt}
                          />
                        </>
                      ) : (
                        <>
                          <Textarea
                            id="inworld-design-profile"
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => setPrompt(e.target.value)}
                            rows={13}
                            maxLength={INWORLD_DESIGN_PROMPT_MAX}
                            spellCheck={false}
                            className="min-h-56 font-mono text-xs leading-5"
                            aria-invalid={invalid}
                          />
                          <div className="flex items-center gap-1.5">
                            <InworldDesignPresetChips
                              mode="structured"
                              value={field.state.value}
                              onSelect={setPrompt}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="ms-auto shrink-0"
                              disabled={!structuredDesignPromptHasValue(field.state.value)}
                              onClick={() => setPrompt(blankStructuredDesignPrompt())}
                              aria-label={t("common.reset")}
                            >
                              <RotateCcw />
                            </Button>
                          </div>
                        </>
                      )}
                      {invalid && <FieldError errors={field.state.meta.errors} />}
                    </Field>
                  )
                }}
              />
            </Field>
          )
        }}
      />

      <form.Field
        name="script"
        children={(field) => {
          const invalid = isFieldInvalid(field)
          return (
            <Field data-invalid={invalid}>
              <div className="flex items-center gap-1.5">
                <FieldLabel htmlFor="inworld-design-script">{t("audio.newVoice.designScriptLabel")}</FieldLabel>
                <VoiceInfoTip
                  content={t("audio.newVoice.designScriptHint")}
                  label={t("audio.newVoice.designScriptHelpAria")}
                />
              </div>
              <Textarea
                id="inworld-design-script"
                name={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => {
                  field.handleChange(e.target.value)
                  if (!existingPreviewAudioId) dropSavedSrc()
                }}
                rows={3}
                maxLength={INWORLD_DESIGN_PREVIEW_TEXT_MAX}
                aria-invalid={invalid}
              />
              {invalid && <FieldError errors={field.state.meta.errors} />}
            </Field>
          )
        }}
      />

      <InworldDesignLocaleFields
        language={language}
        onLanguageChange={onLanguageChange}
        projectId={projectId}
        fileId={fileId}
        session={session}
      />

      <form.Subscribe
        selector={(state) => state.isSubmitting}
        children={(isSubmitting) => (
          <Button type="submit" variant="outline" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner className="size-3" />
                {t("audio.newVoice.designGenerating")}
              </>
            ) : (
              t("audio.newVoice.designGenerate")
            )}
          </Button>
        )}
      />

      {submitError && (
        <FieldError className="select-text cursor-text break-words text-xs">
          {submitError}
        </FieldError>
      )}

      {existingVoiceId && previews.length === 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-primary bg-primary/8 p-1">
            <span className="min-w-0 flex-1 truncate px-2 text-sm">
              {t("audio.newVoice.designSavedLabel")}
            </span>
            <form.Subscribe
              selector={(state) => ({
                submitting: state.isSubmitting,
                script: state.values.script.trim(),
              })}
              children={({ submitting, script }) => {
                const canPlaySaved = Boolean(existingPreviewAudioId)
                  || (
                    script.length >= INWORLD_DESIGN_PREVIEW_TEXT_MIN
                    && script.length <= INWORLD_DESIGN_PREVIEW_TEXT_MAX
                  )
                return (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    disabled={loadingSaved || submitting || (!canPlaySaved && playingId !== existingVoiceId)}
                    aria-label={playingId === existingVoiceId
                      ? t("audio.newVoice.designStopSaved")
                      : t("audio.newVoice.designPlaySaved")}
                    onClick={() => void toggleSaved()}
                  >
                    {loadingSaved ? <Spinner className="size-3.5" /> : playingId === existingVoiceId ? <Pause /> : <Play />}
                  </Button>
                )
              }}
            />
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
            onSelectionChange(unpublishedSelection(preview))
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
    </form>
  )
}
