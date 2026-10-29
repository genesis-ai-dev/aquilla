// NewVoiceModal — one modal, three ways to make a voice:
//   • TTS voice — name it, pick the engine (Inworld / Gemini / ElevenLabs / MMS —
//     seeded from the project's configured engine), and fill that engine's
//     knobs (Gemini: describe how it sounds; MMS: language; Inworld: prebuilt
//     catalog voice (searchable API language + accent, then a stock speaker)
//     or Voice Design, plus quality / delivery / speed; ElevenLabs: connect
//     your own key, then pick or clone an account voice — ElevenLabsVoiceFields).
//     Gemini's base timbre stays a smart default (rotated so each new voice
//     sounds distinct). Leftover Kokoro project defaults remap to Inworld.
//   • Train voice — a custom voice from the org's recordings of a real person
//     (TrainVoicePanel); consent is the org's, confirmed and kept on record.
//     The only way to a real person's voice: short-clip cloning was removed
//     (AQU-2291). Opened from a line's take, that take is the first recording.
//   • Character — one click adds a ready-made synthetic character voice
//     (CharacterVoicePicker, src/lib/audio/character-voices.ts). Change voice
//     re-voices takes into it; no engine or reference clip to set up.
//
// Editing an existing voice reuses this same modal, locked to the voice's kind.
// Deliberately de-purpled: TTS uses the brand accent.

import { useCallback, useMemo, useState } from "react"
import { AudioLines, Drama, GraduationCap, Sparkles, Star, Trash2 } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Dialog, DialogBody, DialogContent } from "@/components/ui/dialog"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AppTooltip } from "@/components/ui/tooltip"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CharacterVoicePicker } from "@/components/voice/CharacterVoicePicker"
import { TrainVoicePanel } from "@/components/voice/TrainVoicePanel"
import { ElevenLabsVoiceFields } from "@/components/voice/elevenlabs/ElevenLabsVoiceFields"
import { voiceFromCharacter } from "@/lib/audio/character-voices"
import { cn } from "@/lib/utils"
import { newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
import {
  DEFAULT_TTS_PROVIDER,
  GEMINI_TTS_VOICES,
  DEFAULT_GEMINI_VOICE,
  DEFAULT_INWORLD_VOICE,
  TTS_PROVIDER_INFOS,
  defaultVoiceNameForProvider,
  isGeminiVoiceName,
  isInworldVoiceName,
  normalizeVoiceForProvider,
  effectiveTtsProvider,
  type TtsProviderInfo,
} from "@/lib/audio/tts-providers"
import {
  DEFAULT_INWORLD_AUDIO_QUALITY,
  DEFAULT_INWORLD_DELIVERY_MODE,
} from "@/lib/audio/inworld-voice-settings"
import { InworldVoiceField } from "@/components/voice/InworldVoiceField"
import { InworldDesignLocaleFields } from "@/components/voice/InworldDesignLocaleFields"
import { InworldVoiceSettings } from "@/components/voice/InworldVoiceSettings"
import {
  InworldVoiceDesignField,
  type InworldDesignSelection,
} from "@/components/voice/InworldVoiceDesignField"
import {
  buildDesignPreviewAudioId,
  inworldDesignPreviewBlob,
  inworldDesignPreviewExt,
  isInworldDesignedVoiceId,
} from "@/lib/audio/inworld-voice-design"
import { explainVoiceRequestError } from "@/lib/audio/voice-request-error"
import { publishInworldVoice } from "@/lib/sync/tts"
import { projectTargetLaneLanguages } from "@/lib/audio/inworld-voices"
import { needsInworldLanguagePicker, toInworldLanguage } from "@/lib/audio/inworld-languages"
import { HAS_EXTENDED_MMS_MODELS, POPULAR_MMS_LANGUAGES } from "@/lib/audio/mms-languages"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { uploadVoiceReference } from "@/lib/audio/voice-clone"
import { fetchTakeAsFile } from "@/lib/audio/take-file"
import type { TtsProvider, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

type Mode = "tts" | "character" | "train"

export interface NewVoiceModalProps {
  open: boolean
  onClose: () => void
  /** Voice being edited; null = creating a new one. */
  voice: Voice | null
  /** Project's configured TTS engine — seeds a new voice's engine. */
  provider?: TtsProvider
  targetLanguage?: string
  /** Extra target-language lanes (not including the default). Archived lanes should already be omitted. */
  targetLanes?: string[]
  archivedLanes?: string[]
  isDefault: boolean
  /** Index used to pick a fresh palette color + base timbre for a new voice. */
  paletteIndex: number
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  cells: CellData[]
  onSave: (voice: Voice) => void
  onDelete?: () => void
  onMakeDefault?: () => void
  /** Open straight to a given tab (e.g. "train" from a line's take). */
  initialMode?: Mode
  /** Opened from a line's take in "train" mode: that line, whose take starts
   *  the training recordings. */
  seedCellId?: string | null
  /** Which of the seed line's takes; defaults to its recording, then its
   *  generated voice. */
  seedAudioId?: string | null
  /** The project's current cast, so the Characters tab marks ones already added. */
  existingVoices?: readonly Voice[]
}

export function NewVoiceModal(props: NewVoiceModalProps) {
  if (!props.open) return null
  return <NewVoiceModalBody key={props.voice?.id ?? props.seedAudioId ?? props.seedCellId ?? "new"} {...props} />
}

/** The take a seeded "train" opening starts from, or null. */
function seedTakeId(cells: CellData[], seedCellId?: string | null, seedAudioId?: string | null): { cell: CellData; audioId: string } | null {
  const cell = seedCellId ? cells.find((c) => c.id === seedCellId) : undefined
  if (!cell) return null
  const audioId = seedAudioId ?? cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId
  return audioId && cell.attachments?.[audioId]?.url ? { cell, audioId } : null
}

function seedDraft(args: {
  voice: Voice | null
  projectProvider: TtsProvider
  targetLanguage?: string
  paletteIndex: number
  rotatedGeminiVoice: string
}): Voice {
  const { voice, projectProvider, targetLanguage, paletteIndex, rotatedGeminiVoice } = args
  const engine = effectiveTtsProvider(projectProvider)
  return voice
    ? { ...voice, provider: effectiveTtsProvider(voice.provider ?? engine) }
    : {
        id: newVoiceId(),
        name: "",
        color: VOICE_PALETTE[paletteIndex % VOICE_PALETTE.length],
        provider: engine,
        voiceName: engine === "gemini"
          ? rotatedGeminiVoice
          : defaultVoiceNameForProvider(engine, { targetLanguage }),
        ...(engine === "inworld"
          ? { audioQuality: DEFAULT_INWORLD_AUDIO_QUALITY, deliveryMode: DEFAULT_INWORLD_DELIVERY_MODE }
          : {}),
      }
}

function NewVoiceModalBody({
  onClose, voice, provider, targetLanguage, targetLanes, archivedLanes, isDefault, paletteIndex, projectId, fileId,
  session, cells, onSave, onDelete, onMakeDefault, initialMode, seedCellId, seedAudioId, existingVoices,
}: NewVoiceModalProps) {
  const t = useT()
  const isNew = voice === null
  const lockedMode: Mode | null = voice
    ? (voice.customVoice ? "train" : voice.libraryVoiceId ? "character" : "tts")
    : null
  const charactersInCast = useMemo(
    () => new Set((existingVoices ?? []).flatMap((v) => (v.libraryVoiceId ? [v.libraryVoiceId] : []))),
    [existingVoices],
  )
  const [mode, setMode] = useState<Mode>(lockedMode ?? initialMode ?? "tts")

  const projectProvider = effectiveTtsProvider(provider ?? DEFAULT_TTS_PROVIDER)
  const catalogLanguages = useMemo(
    () => projectTargetLaneLanguages({ targetLanguage, targetLanes, archivedLanes }),
    [targetLanguage, targetLanes, archivedLanes],
  )
  const languagePicker = needsInworldLanguagePicker(catalogLanguages)
  // Smart default: rotate Gemini's base timbre so a fresh voice sounds distinct
  // without making the user pick one.
  const rotatedGeminiVoice =
    GEMINI_TTS_VOICES[paletteIndex % GEMINI_TTS_VOICES.length]?.name ?? DEFAULT_GEMINI_VOICE

  const [draft, setDraft] = useState<Voice>(() =>
    seedDraft({
      voice,
      projectProvider,
      targetLanguage,
      paletteIndex,
      rotatedGeminiVoice,
    }),
  )
  const update = useCallback((patch: Partial<Voice>) => setDraft((d) => ({ ...d, ...patch })), [])
  // AQU-2032: the Language/Accent fields own `language`. A speaker pick may only
  // seed it when the draft has none — it must never overwrite the accent the
  // user chose, nor clear the language when the speaker carries none.
  const setInworldVoice = useCallback((voiceId: string, language?: string) => {
    setDraft((d) => (d.language ? { ...d, voiceName: voiceId } : { ...d, voiceName: voiceId, language }))
  }, [])
  const inworldLocaleLanguage = draft.language
    ?? catalogLanguages.find((lane) => toInworldLanguage(lane))
    ?? catalogLanguages[0]
  const setInworldLanguage = useCallback((language: string) => {
    update({ language })
  }, [update])
  const [deleteOpen, setDeleteOpen] = useState(false)

  // Engine is per-voice; legacy voices without one follow the project default.
  const activeProvider = effectiveTtsProvider(draft.provider ?? projectProvider)
  const elevenLabsActive = mode === "tts" && activeProvider === "elevenlabs"
  const [elevenLabsCloning, setElevenLabsCloning] = useState(false)

  const pickProvider = useCallback((next: TtsProvider) => {
    setDraft((d) => {
      const normalized = normalizeVoiceForProvider(d, next, { targetLanguage })
      // Switching to Gemini keeps the rotated smart-default timbre.
      if (next === "gemini" && !isGeminiVoiceName(d.voiceName)) {
        normalized.voiceName = rotatedGeminiVoice
      }
      if (next === "inworld" && !isInworldVoiceName(d.voiceName)) {
        normalized.voiceName = DEFAULT_INWORLD_VOICE
      }
      return normalized
    })
  }, [targetLanguage, rotatedGeminiVoice])

  // ── Train from a line's take: that take is the first recording ────────────
  const seedTake = useMemo(() => seedTakeId(cells, seedCellId, seedAudioId), [cells, seedCellId, seedAudioId])
  const seedRecording = useMemo(
    () => (seedTake && projectId
      ? () => fetchTakeAsFile({ projectId, cell: seedTake.cell, audioId: seedTake.audioId, session: session ?? null })
      : undefined),
    [seedTake, projectId, session],
  )
  const [takeError, setTakeError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [inworldSource, setInworldSource] = useState<"prebuilt" | "design">(
    () => (isInworldDesignedVoiceId(voice?.voiceName) ? "design" : "prebuilt"),
  )
  const [designSelection, setDesignSelection] = useState<InworldDesignSelection | null>(() =>
    isInworldDesignedVoiceId(voice?.voiceName) && voice?.voiceName
      ? { voiceId: voice.voiceName, unpublished: false }
      : null,
  )
  const handleSave = useCallback(async () => {
    if (!draft.name.trim()) {
      setTakeError(t("audio.newVoice.errorNameRequired"))
      return
    }
    if (mode === "train") {
      // Only reachable while editing (a new one is saved by TrainVoicePanel): a
      // trained voice can be renamed; its model and consent record are fixed.
      if (voice) onSave({ ...voice, name: draft.name.trim() })
      onClose()
      return
    }
    if (mode === "character") {
      // Only reachable while editing: a new character is added straight from
      // its card. Keep identity + name, drop every engine knob.
      if (!draft.libraryVoiceId) {
        setTakeError(t("audio.newVoice.errorCharacterRequired"))
        return
      }
      onSave({
        id: draft.id,
        name: draft.name.trim(),
        libraryVoiceId: draft.libraryVoiceId,
        ...(draft.color ? { color: draft.color } : {}),
        ...(draft.laneId ? { laneId: draft.laneId } : {}),
      })
      onClose()
      return
    }
    if (
      effectiveTtsProvider(draft.provider ?? projectProvider) === "inworld"
      && languagePicker
      && !toInworldLanguage(draft.language)
      && catalogLanguages.every((lane) => !toInworldLanguage(lane))
    ) {
      setTakeError(t("audio.newVoice.errorInworldLanguageRequired"))
      return
    }
    if (mode === "tts" && effectiveTtsProvider(draft.provider ?? projectProvider) === "elevenlabs" && !draft.elevenLabs?.voiceId) {
      setTakeError(t("audio.elevenLabs.errorVoiceRequired"))
      return
    }
    const designing = mode === "tts"
      && effectiveTtsProvider(draft.provider ?? projectProvider) === "inworld"
      && inworldSource === "design"
    if (designing && !designSelection) {
      setTakeError(t("audio.newVoice.errorDesignPreviewRequired"))
      return
    }
    setTakeError(null)
    let next: Voice = { ...draft, name: draft.name.trim() || "New voice" }
    if (designing && designSelection) {
      let voiceName = designSelection.voiceId
      let designPreviewAudioId = next.designPreviewAudioId
      if (designSelection.unpublished) {
        if (!projectId || !fileId || !session) {
          setTakeError(t("audio.newVoice.errorDesignNoProject"))
          return
        }
        setSaving(true)
        try {
          voiceName = await publishInworldVoice(
            {
              projectId,
              fileId,
              voiceId: designSelection.voiceId,
              displayName: next.name,
              ...(next.prompt ? { description: next.prompt } : {}),
            },
            audioSyncTokenFetcherForSession(session),
          )
          if (designSelection.previewAudio) {
            const blob = inworldDesignPreviewBlob(designSelection.previewAudio)
            const id = buildDesignPreviewAudioId(inworldDesignPreviewExt(designSelection.previewAudio))
            await uploadVoiceReference({
              projectId,
              fileId,
              referenceAudioId: id,
              blob,
              getSyncToken: audioSyncTokenFetcherForSession(session),
            })
            designPreviewAudioId = id
          }
        } catch (e) {
          setTakeError(explainVoiceRequestError(e instanceof Error ? e.message : String(e)))
          setSaving(false)
          return
        }
        setSaving(false)
      }
      next = { ...next, voiceName }
      if (designPreviewAudioId) next.designPreviewAudioId = designPreviewAudioId
    } else if (mode === "tts" && effectiveTtsProvider(next.provider ?? projectProvider) === "inworld") {
      delete next.prompt
      delete next.designPreviewAudioId
    }
    onSave(next)
    onClose()
  }, [
    mode, draft, projectProvider, languagePicker, catalogLanguages,
    inworldSource, designSelection, projectId, fileId, session, onSave, onClose, t,
  ])

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="sm:max-w-lg">
          {/* Header */}
          <h2 className="flex items-center gap-2.5 font-heading text-base font-medium">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/12 text-primary">
              <AudioLines className="h-4 w-4" />
            </span>
            {isNew ? t("audio.newVoice.createLabel") : t("audio.newVoice.titleEdit")}
          </h2>

          {/* Kind tabs — hidden while editing (a voice's kind is fixed). */}
          {isNew && (
            <Tabs
              value={mode}
              onValueChange={(value) => setMode(value as Mode)}
              className="w-full gap-0"
            >
              <TabsList size="lg" className="grid w-full grid-cols-3" aria-label={t("audio.newVoice.kindGroupLabel")}>
                <TabsTrigger value="tts">
                  <Sparkles /> {t("audio.newVoice.tabTts")}
                </TabsTrigger>
                <TabsTrigger value="character">
                  <Drama /> {t("audio.newVoice.tabCharacter")}
                </TabsTrigger>
                <TabsTrigger value="train">
                  <GraduationCap /> {t("audio.newVoice.tabTrain")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          <DialogBody>
            <FieldGroup className="space-y-4 pt-1">
            {mode === "train" ? (
              <TrainVoicePanel
                draft={draft}
                editing={!isNew}
                onNameChange={(name) => update({ name })}
                projectId={projectId}
                fileId={fileId}
                session={session}
                onStarted={(started) => { onSave(started); onClose() }}
                seedRecording={isNew ? seedRecording : undefined}
              />
            ) : mode === "character" ? (
              <CharacterVoicePicker
                editing={!isNew}
                name={draft.name}
                onNameChange={(name) => update({ name })}
                selectedId={draft.libraryVoiceId}
                inCastIds={charactersInCast}
                onPick={(character) => {
                  if (!isNew) {
                    update({ libraryVoiceId: character.id })
                    return
                  }
                  onSave(voiceFromCharacter(character, { id: draft.id, color: draft.color }))
                  onClose()
                }}
              />
            ) : (
            <>
            {/* Name */}
            <Field>
              <FieldLabel htmlFor="voice-name">{t("common.name")}</FieldLabel>
              <Input
                id="voice-name"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                className="h-10"
                placeholder={t("audio.newVoice.namePlaceholder")}
                aria-label={t("audio.newVoice.nameAriaLabel")}
                autoFocus
              />
            </Field>

            {/* Engine — cloud engines + on-device MMS. */}
            <Field>
              <FieldLabel>{t("audio.newVoice.engineLabel")}</FieldLabel>
              <EngineGrid
                infos={TTS_PROVIDER_INFOS}
                active={activeProvider}
                onPick={pickProvider}
              />
            </Field>

            {activeProvider === "mms" && (
              <MmsLanguageField
                value={draft.voiceName ?? ""}
                onChange={(v) => update({ voiceName: v || undefined })}
              />
            )}
            {activeProvider === "inworld" && (
              <>
                <Tabs
                  value={inworldSource}
                  onValueChange={(value) => setInworldSource(value as "prebuilt" | "design")}
                  className="gap-0"
                >
                  <TabsList aria-label={t("audio.newVoice.inworldSourceGroupLabel")}>
                    <TabsTrigger value="prebuilt">
                      {t("audio.newVoice.tabPrebuilt")}
                    </TabsTrigger>
                    <TabsTrigger value="design">
                      {t("audio.newVoice.tabDesign")}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {inworldSource === "prebuilt" ? (
                  <>
                    <InworldDesignLocaleFields
                      copy="catalog"
                      voicesOnly
                      language={inworldLocaleLanguage}
                      onLanguageChange={setInworldLanguage}
                      projectId={projectId}
                      fileId={fileId}
                      session={session}
                    />
                    <InworldVoiceField
                      value={draft.voiceName}
                      language={draft.language}
                      onChange={setInworldVoice}
                      targetLanguages={draft.language ? [draft.language] : catalogLanguages}
                      projectId={projectId}
                      fileId={fileId}
                      session={session}
                    />
                  </>
                ) : (
                  <InworldVoiceDesignField
                    prompt={draft.prompt ?? ""}
                    onPromptChange={(prompt) => update({ prompt: prompt || undefined })}
                    selection={designSelection}
                    onSelectionChange={setDesignSelection}
                    existingVoiceId={isInworldDesignedVoiceId(draft.voiceName) ? draft.voiceName : undefined}
                    existingPreviewAudioId={draft.designPreviewAudioId}
                    language={draft.language ?? catalogLanguages.find((lane) => toInworldLanguage(lane))}
                    onLanguageChange={setInworldLanguage}
                    projectId={projectId}
                    fileId={fileId}
                    session={session}
                    speakingRate={draft.speakingRate}
                    deliveryMode={draft.deliveryMode}
                    audioQuality={draft.audioQuality}
                  />
                )}
              </>
            )}
            {activeProvider === "inworld" && (
              <InworldVoiceSettings
                voice={draft}
                onChange={update}
                previewIgnored={inworldSource === "design"}
              />
            )}
            {activeProvider === "elevenlabs" && (
              <ElevenLabsVoiceFields
                draft={draft}
                onChange={update}
                projectId={projectId}
                fileId={fileId}
                session={session}
                cells={cells}
                targetLanguage={inworldLocaleLanguage}
                editing={!isNew}
                onCloningChange={setElevenLabsCloning}
              />
            )}
            {activeProvider === "gemini" && (
              <Field>
                <FieldLabel htmlFor="voice-describe">{t("audio.newVoice.describeLabel")}</FieldLabel>
                <Textarea
                  id="voice-describe"
                  value={draft.prompt ?? ""}
                  onChange={(e) => update({ prompt: e.target.value || undefined })}
                  rows={3}
                  placeholder={t("audio.newVoice.describePlaceholder")}
                />
              </Field>
            )}

            </>
            )}
            </FieldGroup>
          </DialogBody>

          {/* Footer */}
          <div className="-mx-5 -mb-5 mt-2 flex flex-col gap-2 rounded-b-3xl bg-muted/40 p-5">
            {takeError && (
              <p className="select-text cursor-text break-words text-xs text-destructive" role="alert">{takeError}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {onMakeDefault && !isDefault && (
                <AppTooltip content={t("audio.newVoice.makeNarratorHint")}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("audio.newVoice.makeNarratorButton")}
                    onClick={onMakeDefault}
                  >
                    <Star className="fill-current" />
                  </Button>
                </AppTooltip>
              )}
              {isDefault && (
                <AppTooltip content={t("audio.narrator")}>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("audio.narrator")}
                    className="border-primary text-primary hover:border-primary hover:bg-primary/10 hover:text-primary dark:border-primary dark:hover:border-primary dark:hover:bg-primary/10 dark:hover:text-primary"
                  >
                    <Star className="fill-current" />
                  </Button>
                </AppTooltip>
              )}
              {onDelete && !draft.builtIn && (
                <Button
                  type="button" variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="me-1 h-3.5 w-3.5" /> {t("common.delete")}
                </Button>
              )}
              <div className="ms-auto flex gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
                {!(isNew && (mode === "character" || mode === "train")) && !(elevenLabsActive && elevenLabsCloning) && (
                  <Button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving || (elevenLabsActive && !draft.elevenLabs?.voiceId)}
                  >
                    {saving ? <Spinner className="size-3" /> : null}
                    {isNew ? t("audio.newVoice.createButton") : t("common.save")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {onDelete && (
        <ConfirmActionDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={t("audio.newVoice.deleteDialogTitle")}
          description={t("audio.newVoice.deleteDialogDescription", { voiceName: draft.name || t("audio.newVoice.unnamedVoiceFallback") })}
          confirmLabel={t("audio.newVoice.deleteDialogTitle")}
          checkboxLabel={t("audio.newVoice.deleteDialogCheckbox")}
          variant="destructive"
          onConfirm={() => { onDelete(); onClose() }}
        />
      )}
    </>
  )
}

function EngineGrid({
  infos,
  active,
  onPick,
}: {
  infos: readonly TtsProviderInfo[]
  active: TtsProvider
  onPick: (id: TtsProvider) => void
}) {
  const t = useT()
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {infos.map((info) => (
        <AppTooltip key={info.id} content={t(info.hintKey)} className="max-w-xs">
          <button
            type="button"
            onClick={() => onPick(info.id)}
            aria-pressed={active === info.id}
            className={cn(
              "rounded-lg border px-2.5 py-2 text-start transition-colors",
              active === info.id ? "border-primary bg-primary/10" : "hover:bg-accent/40",
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium">{info.shortTitle}</span>
              {info.badge && <Badge variant={info.requiresElevenLabsKey ? "outline" : "default"}>{info.badge}</Badge>}
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{info.blurb}</p>
            {info.caveat && (
              <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground/70">{info.caveat}</p>
            )}
          </button>
        </AppTooltip>
      ))}
    </div>
  )
}

/** MMS voiceName is a language code: a popular-languages select, plus a raw
 *  code input when extended models are available. */
function MmsLanguageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  const knownCode = POPULAR_MMS_LANGUAGES.some((l) => l.code === value)
  const selectValue = knownCode ? value : HAS_EXTENDED_MMS_MODELS ? "__other__" : ""
  const mmsOptions: { value: string; label: string; disabled?: boolean }[] = [
    ...(!knownCode && !HAS_EXTENDED_MMS_MODELS
      ? [{
          value: "",
          label: value ? t("audio.newVoice.mmsUnsupportedCode", { code: value }) : t("audio.newVoice.mmsChooseLanguage"),
          disabled: true,
        }]
      : []),
    ...POPULAR_MMS_LANGUAGES.map((l) => ({ value: l.code, label: `${l.name} (${l.code})` })),
    ...(HAS_EXTENDED_MMS_MODELS ? [{ value: "__other__", label: t("audio.newVoice.mmsOtherCode") }] : []),
  ]
  return (
    <>
      <Field>
        <FieldLabel htmlFor="voice-mms-lang">{t("audio.newVoice.mmsLanguageLabel")}</FieldLabel>
        <Select
          items={mmsOptions.map((o) => ({ value: o.value, label: o.label }))}
          value={selectValue}
          onValueChange={(v) => {
            const next = v ?? ""
            onChange(next === "__other__" ? "" : next)
          }}
        >
          <SelectTrigger id="voice-mms-lang">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {mmsOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      {HAS_EXTENDED_MMS_MODELS && (
        <Field>
          <FieldLabel htmlFor="voice-mms-code">{t("audio.newVoice.mmsCodeLabel")}</FieldLabel>
          <Input
            id="voice-mms-code"
            value={value}
            onChange={(e) => onChange(e.target.value.trim().toLowerCase())}
            // i18n-exempt: fixed ISO 639-3 code example (Italian), not translatable prose
            placeholder="ita"
            className="font-mono"
          />
        </Field>
      )}
    </>
  )
}
