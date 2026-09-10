// NewVoiceModal — one modal, two ways to make a voice:
//   • TTS voice — name it, pick the engine (Inworld / Gemini / Kokoro / MMS —
//     seeded from the project's configured engine), and fill that engine's
//     knobs (Gemini: describe how it sounds; Kokoro: pick a bundled speaker;
//     MMS: language; Inworld: prebuilt catalog voice (searchable API language
//     + accent, then a stock speaker) or Voice Design, plus
//     quality / delivery / speed).
//     Gemini's base timbre stays a smart default (rotated so each new voice
//     sounds distinct).
//   • Clone voice — name it, pick a cloud engine that can clone (Inworld /
//     Gemini — Kokoro and MMS are on-device and cannot), and capture a short
//     reference clip (record, upload, or reuse a take). Generation is re-voiced
//     to match it. A local project default is remapped to Inworld on this tab.
//
// Editing an existing voice reuses this same modal, locked to the voice's kind
// (TTS: all four engines; clone: cloud clone engines only).
// Deliberately de-purpled: TTS uses the brand accent, Clone uses emerald.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AudioLines, Check, Pause, Play, Sparkles, Star, Trash2, UserRound } from "lucide-react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { VoiceCloneSection } from "@/components/VoiceCloneSection"
import { KokoroVoiceField } from "@/components/voice/KokoroVoiceField"
import { cn } from "@/lib/utils"
import { isRecordedCloneClip, newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
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
  providerInfo,
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
import { publishInworldVoice } from "@/lib/sync/tts"
import { projectTargetLaneLanguages } from "@/lib/audio/inworld-voices"
import { needsInworldLanguagePicker, toInworldLanguage } from "@/lib/audio/inworld-languages"
import { HAS_EXTENDED_MMS_MODELS, POPULAR_MMS_LANGUAGES } from "@/lib/audio/mms-languages"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { audioMimeForExt } from "@/lib/audio/mime"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import { parseFrontierAudioUrl, fetchCellAudio } from "@/lib/audio/upload"
import type { TtsProvider, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

type Mode = "tts" | "clone"

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
  /** Open straight to a given tab (e.g. seeded "clone from this take"). */
  initialMode?: Mode
  /** When opened from a line's take, preselect + highlight that take. */
  seedCellId?: string | null
}

export function NewVoiceModal(props: NewVoiceModalProps) {
  if (!props.open) return null
  return <NewVoiceModalBody key={props.voice?.id ?? props.seedCellId ?? "new"} {...props} />
}

interface TakeSource {
  cell: CellData
  slot: "recorded" | "generated"
  audioId: string
}

const slotUrl = (cell: CellData, audioId: string): string | undefined => cell.attachments?.[audioId]?.url
const takeKey = (t: TakeSource): string => `${t.cell.id}:${t.slot}`

function cellSnippet(cell: CellData): string {
  const raw = (cell.translated || cell.original || cell.cellLabel || cell.id).trim()
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw || cell.id
}

function audioSources(cells: CellData[]): TakeSource[] {
  const out: TakeSource[] = []
  for (const cell of cells) {
    if (cell.selectedAudioId && slotUrl(cell, cell.selectedAudioId)) {
      out.push({ cell, slot: "recorded", audioId: cell.selectedAudioId })
    }
    if (cell.selectedGeneratedVoiceAudioId && slotUrl(cell, cell.selectedGeneratedVoiceAudioId)) {
      out.push({ cell, slot: "generated", audioId: cell.selectedGeneratedVoiceAudioId })
    }
  }
  return out
}

const mimeForExt = (ext: string): string =>
  ext === "webm" ? "audio/webm"
  : ext === "mp3" ? "audio/mpeg"
  : ext === "mp4" || ext === "m4a" ? "audio/mp4"
  : ext === "wav" ? "audio/wav"
  : "application/octet-stream"

const CLONE_ENGINES = TTS_PROVIDER_INFOS.filter((p) => p.supportsCloning)

function seedDraft(args: {
  voice: Voice | null
  projectProvider: TtsProvider
  targetLanguage?: string
  paletteIndex: number
  initialMode?: Mode
  rotatedGeminiVoice: string
}): Voice {
  const { voice, projectProvider, targetLanguage, paletteIndex, initialMode, rotatedGeminiVoice } = args
  const engine = effectiveTtsProvider(projectProvider)
  const base: Voice = voice
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
  const openingClone = Boolean(voice?.referenceAudioId) || initialMode === "clone"
  if (openingClone && !providerInfo(base.provider ?? projectProvider).supportsCloning) {
    return normalizeVoiceForProvider(base, DEFAULT_TTS_PROVIDER, { targetLanguage })
  }
  return base
}

function NewVoiceModalBody({
  onClose, voice, provider, targetLanguage, targetLanes, archivedLanes, isDefault, paletteIndex, projectId, fileId,
  session, cells, onSave, onDelete, onMakeDefault, initialMode, seedCellId,
}: NewVoiceModalProps) {
  const t = useT()
  const isNew = voice === null
  const lockedMode: Mode | null = voice ? (voice.referenceAudioId ? "clone" : "tts") : null
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
      initialMode,
      rotatedGeminiVoice,
    }),
  )
  const update = useCallback((patch: Partial<Voice>) => setDraft((d) => ({ ...d, ...patch })), [])
  const setInworldVoice = useCallback((voiceId: string, language?: string) => {
    update({ voiceName: voiceId, language })
  }, [update])
  const inworldLocaleLanguage = draft.language
    ?? catalogLanguages.find((lane) => toInworldLanguage(lane))
    ?? catalogLanguages[0]
  const setInworldLanguage = useCallback((language: string) => {
    update({ language })
  }, [update])
  const [deleteOpen, setDeleteOpen] = useState(false)

  // Engine is per-voice; legacy voices without one follow the project default.
  const activeProvider = effectiveTtsProvider(draft.provider ?? projectProvider)

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

  // ── Clone: reuse a take already in the project ──────────────────────────────
  const takes = useMemo(() => {
    const all = audioSources(cells)
    return [...all.filter((t) => t.slot === "recorded"), ...all.filter((t) => t.slot === "generated")]
  }, [cells])
  const [liftingKey, setLiftingKey] = useState<string | null>(null)
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
  const applyTake = useCallback(async (take: TakeSource) => {
    if (liftingKey) return
    if (!projectId) { setTakeError(t("audio.newVoice.errorNoProjectContext")); return }
    const url = slotUrl(take.cell, take.audioId)
    const parsed = url ? parseFrontierAudioUrl(url) : null
    if (!parsed) { setTakeError(t("audio.newVoice.errorAudioUnavailable")); return }
    const key = takeKey(take)
    setLiftingKey(key)
    setTakeError(null)
    try {
      const getSyncToken = audioSyncTokenFetcherForSession(session ?? null)
      const bytes = await fetchCellAudio({
        projectId, fileId: take.cell.fileId, audioId: parsed.audioId, ext: parsed.ext, getSyncToken,
      })
      const blob = new Blob([bytes as BlobPart], { type: mimeForExt(parsed.ext) })
      const referenceAudioId = buildVoiceReferenceId(parsed.ext)
      await uploadVoiceReference({ projectId, fileId: take.cell.fileId, referenceAudioId, blob, getSyncToken })
      update({ referenceAudioId, referenceTakeKey: key })
    } catch (e) {
      setTakeError(e instanceof Error ? e.message : String(e))
    } finally {
      setLiftingKey(null)
    }
  }, [liftingKey, projectId, session, update, t])

  const hasReference = Boolean(draft.referenceAudioId)

  const handleSave = useCallback(async () => {
    if (!draft.name.trim()) {
      setTakeError(t("audio.newVoice.errorNameRequired"))
      return
    }
    if (mode === "clone" && !hasReference) {
      setTakeError(t("audio.newVoice.errorReferenceRequired"))
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
    const designing = mode === "tts"
      && effectiveTtsProvider(draft.provider ?? projectProvider) === "inworld"
      && inworldSource === "design"
    if (designing && !designSelection) {
      setTakeError(t("audio.newVoice.errorDesignPreviewRequired"))
      return
    }
    setTakeError(null)
    const fallback = mode === "clone" ? "Cloned voice" : "New voice"
    let next: Voice = { ...draft, name: draft.name.trim() || fallback }
    if (mode === "clone") {
      // A clone rides a cloning-capable engine; fall back to the hosted default
      // if the draft's engine (kokoro/mms) can't re-voice a reference.
      const base = draft.provider ?? projectProvider
      const cloneProvider = providerInfo(base).supportsCloning ? base : DEFAULT_TTS_PROVIDER
      next = normalizeVoiceForProvider(next, cloneProvider, { targetLanguage })
    } else if (next.referenceAudioId || next.referenceTakeKey) {
      // A TTS voice never carries a reference (e.g. one added then abandoned by
      // switching tabs) — a lingering one would silently make it a clone.
      delete next.referenceAudioId
      delete next.referenceTakeKey
    }
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
          setTakeError(e instanceof Error ? e.message : String(e))
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
    mode, draft, hasReference, projectProvider, targetLanguage, languagePicker, catalogLanguages,
    inworldSource, designSelection, projectId, fileId, session, onSave, onClose, t,
  ])

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="sm:max-w-md">
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
              onValueChange={(value) => {
                const next = value as Mode
                setMode(next)
                if (next === "clone") {
                  const current = draft.provider ?? projectProvider
                  if (!providerInfo(current).supportsCloning) pickProvider(DEFAULT_TTS_PROVIDER)
                }
              }}
              className="w-full gap-0"
            >
              <TabsList size="lg" className="grid w-full grid-cols-2" aria-label={t("audio.newVoice.kindGroupLabel")}>
                <TabsTrigger value="tts">
                  <Sparkles /> {t("audio.newVoice.tabTts")}
                </TabsTrigger>
                <TabsTrigger value="clone">
                  <UserRound /> {t("audio.newVoice.tabClone")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          <DialogBody>
            <FieldGroup className="space-y-4 pt-1">
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

            {/* Engine — TTS offers all four; clone only the cloud engines that
                can re-voice a reference. Same slot on both tabs so the control
                doesn't jump. */}
            <Field>
              <FieldLabel>{t("audio.newVoice.engineLabel")}</FieldLabel>
              <EngineGrid
                infos={mode === "clone" ? CLONE_ENGINES : TTS_PROVIDER_INFOS}
                active={activeProvider}
                onPick={pickProvider}
              />
            </Field>

            {mode === "tts" && activeProvider === "kokoro" && (
              <KokoroVoiceField
                value={draft.voiceName ?? ""}
                targetLanguage={targetLanguage}
                onChange={(v) => update({ voiceName: v || undefined })}
              />
            )}
            {mode === "tts" && activeProvider === "mms" && (
              <MmsLanguageField
                value={draft.voiceName ?? ""}
                onChange={(v) => update({ voiceName: v || undefined })}
              />
            )}
            {mode === "clone" && activeProvider === "inworld" && (
              <InworldDesignLocaleFields
                copy="catalog"
                language={inworldLocaleLanguage}
                onLanguageChange={setInworldLanguage}
                projectId={projectId}
                fileId={fileId}
                session={session}
              />
            )}
            {mode === "tts" && activeProvider === "inworld" && (
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
                previewIgnored={mode === "tts" && inworldSource === "design"}
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

            {mode === "clone" && (
              <CloneReferenceSource
                voice={draft}
                projectId={projectId}
                fileId={fileId}
                session={session}
                onChange={update}
                takes={takes}
                seedCellId={seedCellId}
                liftingKey={liftingKey}
                takeError={takeError}
                onApplyTake={(take) => void applyTake(take)}
              />
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
                    type="button" variant="outline" onClick={onMakeDefault}
                  >
                    <Star className="me-1 h-3.5 w-3.5" /> {t("audio.newVoice.makeNarratorButton")}
                  </Button>
                </AppTooltip>
              )}
              {isDefault && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Star className="h-3.5 w-3.5 text-primary" /> {t("audio.narrator")}
                </span>
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
                <Button type="button" onClick={() => void handleSave()} disabled={saving}>
                  {saving ? <Spinner className="size-3" /> : null}
                  {isNew ? t("audio.newVoice.createButton") : t("common.save")}
                </Button>
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

type CloneSource = "record" | "line"

function CloneReferenceSource({
  voice,
  projectId,
  fileId,
  session,
  onChange,
  takes,
  seedCellId,
  liftingKey,
  takeError,
  onApplyTake,
}: {
  voice: Voice
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  onChange: (patch: Partial<Voice>) => void
  takes: TakeSource[]
  seedCellId?: string | null
  liftingKey: string | null
  takeError: string | null
  onApplyTake: (take: TakeSource) => void
}) {
  const t = useT()
  const seededTakePresent = seedCellId != null && takes.some((take) => take.cell.id === seedCellId)
  const clipFilled = isRecordedCloneClip(voice)
  const [source, setSource] = useState<CloneSource>(
    voice.referenceTakeKey || seededTakePresent ? "line" : "record",
  )
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const chosenRowRef = useRef<HTMLDivElement | null>(null)
  const seededTake = seedCellId != null ? takes.find((take) => take.cell.id === seedCellId) : undefined
  const highlightKey = voice.referenceTakeKey ?? (seededTake ? takeKey(seededTake) : null)

  useLayoutEffect(() => {
    if (source !== "line" || !highlightKey) return
    chosenRowRef.current?.scrollIntoView({ block: "center" })
  }, [source, highlightKey])

  const stopPlayback = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setPlayingKey(null)
  }, [])

  useEffect(() => () => stopPlayback(), [stopPlayback])

  const playTake = useCallback(async (take: TakeSource) => {
    const key = takeKey(take)
    if (playingKey === key) {
      stopPlayback()
      return
    }
    stopPlayback()
    if (!projectId) return
    const url = slotUrl(take.cell, take.audioId)
    const parsed = url ? parseFrontierAudioUrl(url) : null
    if (!parsed) return
    setLoadingKey(key)
    try {
      const bytes = await fetchCellAudio({
        projectId,
        fileId: take.cell.fileId,
        audioId: parsed.audioId,
        ext: parsed.ext,
        getSyncToken: audioSyncTokenFetcherForSession(session ?? null),
      })
      const src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: audioMimeForExt(parsed.ext) }))
      urlRef.current = src
      const audio = new Audio(src)
      audioRef.current = audio
      audio.onended = () => stopPlayback()
      await audio.play()
      if (audioRef.current !== audio) {
        audio.pause()
        return
      }
      setPlayingKey(key)
    } catch {
      stopPlayback()
    } finally {
      setLoadingKey((cur) => (cur === key ? null : cur))
    }
  }, [playingKey, stopPlayback, projectId, session])

  return (
    <Tabs
      value={source}
      onValueChange={(value) => setSource(value as CloneSource)}
      className="gap-2"
    >
      <TabsList aria-label={t("audio.newVoice.referenceSourceGroupLabel")}>
        <TabsTrigger value="record" className="pe-3">
          {t("audio.newVoice.referenceLabel")}
          {clipFilled && (
            <span aria-hidden className="absolute end-2 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-emerald-500" />
          )}
        </TabsTrigger>
        <TabsTrigger value="line" className="pe-3">
          {t("audio.newVoice.tabFromLine")}
          {voice.referenceTakeKey && (
            <span aria-hidden className="absolute end-2 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-emerald-500" />
          )}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="record" className="space-y-2">
        <VoiceCloneSection
          voice={voice}
          projectId={projectId}
          fileId={fileId}
          session={session}
          onChange={onChange}
        />
      </TabsContent>
      <TabsContent value="line" className="space-y-2">
        {takes.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("audio.newVoice.fromLineEmpty")}</p>
        ) : (
          <>
            <div className="max-h-40 space-y-1 overflow-auto rounded-lg border bg-muted/20 p-1">
              {takes.map((take) => {
                const key = takeKey(take)
                const chosen = key === highlightKey
                return (
                  <div
                    key={key}
                    ref={chosen ? chosenRowRef : undefined}
                    className="flex w-full items-stretch rounded-md hover:bg-accent/40"
                  >
                    <AppTooltip content={playingKey === key ? t("common.stop") : t("audio.takesStrip.playTakeTooltip")}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        disabled={Boolean(liftingKey) || !projectId}
                        aria-label={playingKey === key ? t("common.stop") : t("audio.takesStrip.playTakeTooltip")}
                        className="ms-1.5 self-center"
                        onClick={() => void playTake(take)}
                      >
                        {loadingKey === key ? (
                          <Spinner className="size-3" />
                        ) : playingKey === key ? (
                          <Pause className="h-3.5 w-3.5" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </AppTooltip>
                    <button
                      type="button"
                      onClick={() => onApplyTake(take)}
                      disabled={Boolean(liftingKey) && liftingKey !== key}
                      aria-pressed={chosen}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-2.5 text-start text-xs disabled:opacity-50"
                    >
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {take.slot === "generated" && (
                          <AppTooltip content={t("audio.newVoice.takeGenerated")}>
                            <span className="inline-flex" aria-label={t("audio.newVoice.takeGenerated")}>
                              <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                            </span>
                          </AppTooltip>
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{cellSnippet(take.cell)}</span>
                      <span className="flex w-3.5 shrink-0 justify-center">
                        {liftingKey === key ? (
                          <Spinner className="size-3.5" aria-label={t("audio.newVoice.liftingTake")} />
                        ) : chosen ? (
                          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                        ) : null}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
            {takeError && (
              <p className="select-text cursor-text break-words rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {takeError}
              </p>
            )}
          </>
        )}
      </TabsContent>
    </Tabs>
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
              {info.badge && <Badge>{info.badge}</Badge>}
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
