// NewVoiceModal — one modal, two ways to make a voice:
//   • TTS voice — name it, pick the engine (OmniVoice / Gemini / Kokoro / MMS —
//     seeded from the project's configured engine), and fill the engine's one
//     knob (Gemini: describe how it sounds; Kokoro: voice id; MMS: language;
//     OmniVoice: nothing). Gemini's base timbre stays a smart default (rotated
//     so each new voice sounds distinct).
//   • Clone voice — name it + capture a short reference clip (record, upload, or
//     reuse a take already in the project). Generation is re-voiced to match it.
//
// Editing an existing voice reuses this same modal, locked to the voice's kind
// (the engine stays switchable for TTS voices).
// Deliberately de-purpled: TTS uses the brand accent, Clone uses emerald.

import { useCallback, useMemo, useState } from "react"
import { AudioLines, Check, Plus, Sparkles, Star, Trash2, UserRound } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AppTooltip } from "@/components/ui/tooltip"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import { VoiceCloneSection } from "@/components/VoiceCloneSection"
import { cn } from "@/lib/utils"
import { newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
import {
  DEFAULT_TTS_PROVIDER,
  GEMINI_TTS_VOICES,
  DEFAULT_GEMINI_VOICE,
  TTS_PROVIDER_INFOS,
  defaultVoiceNameForProvider,
  isGeminiVoiceName,
  normalizeVoiceForProvider,
  providerInfo,
} from "@/lib/audio/tts-providers"
import { HAS_EXTENDED_MMS_MODELS, POPULAR_MMS_LANGUAGES } from "@/lib/audio/mms-languages"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
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

function NewVoiceModalBody({
  onClose, voice, provider, targetLanguage, isDefault, paletteIndex, projectId, fileId,
  session, cells, onSave, onDelete, onMakeDefault, initialMode, seedCellId,
}: NewVoiceModalProps) {
  const t = useT()
  const isNew = voice === null
  const lockedMode: Mode | null = voice ? (voice.referenceAudioId ? "clone" : "tts") : null
  const [mode, setMode] = useState<Mode>(lockedMode ?? initialMode ?? "tts")

  const projectProvider = provider ?? DEFAULT_TTS_PROVIDER
  // Smart default: rotate Gemini's base timbre so a fresh voice sounds distinct
  // without making the user pick one.
  const rotatedGeminiVoice =
    GEMINI_TTS_VOICES[paletteIndex % GEMINI_TTS_VOICES.length]?.name ?? DEFAULT_GEMINI_VOICE

  const [draft, setDraft] = useState<Voice>(() =>
    voice ?? {
      id: newVoiceId(),
      name: "",
      color: VOICE_PALETTE[paletteIndex % VOICE_PALETTE.length],
      provider: projectProvider,
      voiceName: projectProvider === "gemini"
        ? rotatedGeminiVoice
        : defaultVoiceNameForProvider(projectProvider, { targetLanguage }),
    },
  )
  const update = useCallback((patch: Partial<Voice>) => setDraft((d) => ({ ...d, ...patch })), [])
  const [deleteOpen, setDeleteOpen] = useState(false)

  // Engine is per-voice; legacy voices without one follow the project default.
  const activeProvider = draft.provider ?? projectProvider
  const activeInfo = providerInfo(activeProvider)

  const pickProvider = useCallback((next: TtsProvider) => {
    setDraft((d) => {
      const normalized = normalizeVoiceForProvider(d, next, { targetLanguage })
      // Switching to Gemini keeps the rotated smart-default timbre.
      if (next === "gemini" && !isGeminiVoiceName(d.voiceName)) {
        normalized.voiceName = rotatedGeminiVoice
      }
      return normalized
    })
  }, [targetLanguage, rotatedGeminiVoice])

  // ── Clone: reuse a take already in the project ──────────────────────────────
  const takes = useMemo(() => {
    const all = audioSources(cells)
    return [...all.filter((t) => t.slot === "recorded"), ...all.filter((t) => t.slot === "generated")]
  }, [cells])
  const seededTakePresent = seedCellId != null && takes.some((t) => t.cell.id === seedCellId)
  const [takeBusy, setTakeBusy] = useState(false)
  const [takeError, setTakeError] = useState<string | null>(null)
  const applyTake = useCallback(async (take: TakeSource) => {
    if (!projectId) { setTakeError(t("audio.newVoice.errorNoProjectContext")); return }
    const url = slotUrl(take.cell, take.audioId)
    const parsed = url ? parseFrontierAudioUrl(url) : null
    if (!parsed) { setTakeError(t("audio.newVoice.errorAudioUnavailable")); return }
    setTakeBusy(true)
    setTakeError(null)
    try {
      const getSyncToken = audioSyncTokenFetcherForSession(session ?? null)
      const bytes = await fetchCellAudio({
        projectId, fileId: take.cell.fileId, audioId: parsed.audioId, ext: parsed.ext, getSyncToken,
      })
      const blob = new Blob([bytes as BlobPart], { type: mimeForExt(parsed.ext) })
      const referenceAudioId = buildVoiceReferenceId(parsed.ext)
      await uploadVoiceReference({ projectId, fileId: take.cell.fileId, referenceAudioId, blob, getSyncToken })
      update({ referenceAudioId })
    } catch (e) {
      setTakeError(e instanceof Error ? e.message : String(e))
    } finally {
      setTakeBusy(false)
    }
  }, [projectId, session, update, t])

  const hasReference = Boolean(draft.referenceAudioId)

  const handleSave = useCallback(() => {
    if (!draft.name.trim()) {
      setTakeError(t("audio.newVoice.errorNameRequired"))
      return
    }
    if (mode === "clone" && !hasReference) {
      setTakeError(t("audio.newVoice.errorReferenceRequired"))
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
    } else if (next.referenceAudioId) {
      // A TTS voice never carries a reference (e.g. one added then abandoned by
      // switching tabs) — a lingering one would silently make it a clone.
      delete next.referenceAudioId
    }
    onSave(next)
    onClose()
  }, [mode, draft, hasReference, projectProvider, targetLanguage, onSave, onClose, t])

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
              onValueChange={(value) => setMode(value as Mode)}
              className="gap-0"
            >
              <TabsList size="lg" className="w-full" aria-label={t("audio.newVoice.kindGroupLabel")}>
                <TabsTrigger value="tts">
                  <Sparkles /> {t("audio.newVoice.tabTts")}
                </TabsTrigger>
                <TabsTrigger value="clone">
                  <UserRound /> {t("audio.newVoice.tabClone")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          )}

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

            {mode === "tts" ? (
              <>
                {/* Engine — per-voice, seeded from the project's configured one.
                    Switching resets the base voice to that engine's default. */}
                <Field>
                  <FieldLabel>{t("audio.newVoice.engineLabel")}</FieldLabel>
                  <div className="grid grid-cols-2 gap-1.5">
                    {TTS_PROVIDER_INFOS.map((info) => (
                      <AppTooltip key={info.id} content={info.hint} className="max-w-xs">
                        <button
                          type="button"
                          onClick={() => pickProvider(info.id)}
                          aria-pressed={activeProvider === info.id}
                          className={cn(
                            "rounded-lg border px-2.5 py-2 text-left transition-colors",
                            activeProvider === info.id ? "border-primary bg-primary/10" : "hover:bg-accent/40",
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
                </Field>

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
                {activeProvider === "kokoro" && (
                  <Field>
                    <FieldLabel htmlFor="voice-kokoro">{t("audio.newVoice.kokoroLabel")}</FieldLabel>
                    <Input
                      id="voice-kokoro"
                      value={draft.voiceName ?? ""}
                      onChange={(e) => update({ voiceName: e.target.value || undefined })}
                      placeholder={t("audio.newVoice.kokoroPlaceholder")}
                      className="font-mono"
                    />
                  </Field>
                )}
                {activeProvider === "mms" && (
                  <MmsLanguageField
                    value={draft.voiceName ?? ""}
                    onChange={(v) => update({ voiceName: v || undefined })}
                  />
                )}
                {activeProvider === "omnivoice" && (
                  <p className="text-xs text-muted-foreground">
                    {t("audio.newVoice.singleVoiceHint", { engine: activeInfo.title })}
                  </p>
                )}
              </>
            ) : (
              <Field>
                <FieldLabel>{t("audio.newVoice.referenceLabel")}</FieldLabel>
                <VoiceCloneSection
                  voice={draft}
                  projectId={projectId}
                  fileId={fileId}
                  session={session}
                  onChange={update}
                />
                <FieldDescription>
                  {t("audio.newVoice.referenceDescription")}
                </FieldDescription>

                {/* Or reuse audio already in the project. */}
                {takes.length > 0 && (
                  <details open={seededTakePresent} className="rounded-lg border bg-muted/10">
                    <summary className="px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                      {t("audio.newVoice.reuseTakeSummary")}
                    </summary>
                    <div className="space-y-1.5 px-3 pb-3">
                      <div className="max-h-40 space-y-1 overflow-auto rounded-lg border bg-muted/20 p-1">
                        {takes.map((take) => {
                          const seeded = seedCellId != null && take.cell.id === seedCellId
                          return (
                            <button
                              key={takeKey(take)}
                              type="button"
                              onClick={() => void applyTake(take)}
                              disabled={takeBusy}
                              className={cn(
                                "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50",
                                seeded ? "border-emerald-500 bg-emerald-500/10" : "border-transparent hover:bg-accent/40",
                              )}
                            >
                              <span className="truncate">{cellSnippet(take.cell)}</span>
                              <span
                                className={cn(
                                  "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                                  take.slot === "recorded"
                                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {take.slot === "recorded" ? t("audio.newVoice.takeRecorded") : t("audio.newVoice.takeGenerated")}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                      {takeBusy && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Spinner className="h-3.5 w-3.5" /> {t("audio.newVoice.liftingTake")}
                        </p>
                      )}
                      {takeError && (
                        <p className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                          {takeError}
                        </p>
                      )}
                    </div>
                  </details>
                )}
              </Field>
            )}
          </FieldGroup>

          {/* Footer */}
          <div className="-mx-5 -mb-5 mt-2 flex flex-wrap items-center gap-2 rounded-b-3xl bg-muted/40 p-5">
            {onMakeDefault && !isDefault && (
              <AppTooltip content={t("audio.newVoice.makeNarratorHint")}>
                <Button
                  type="button" size="sm" variant="outline" onClick={onMakeDefault}
                >
                  <Star className="mr-1 h-3.5 w-3.5" /> {t("audio.newVoice.makeNarratorButton")}
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
                type="button" size="sm" variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> {t("common.delete")}
              </Button>
            )}
            <div className="ml-auto flex flex-col items-end gap-1">
              {takeError && (
                <p className="text-xs text-destructive" role="alert">{takeError}</p>
              )}
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
                <Button type="button" size="sm" onClick={handleSave}>
                  {isNew ? <><Plus className="mr-1 h-3.5 w-3.5" /> {t("audio.newVoice.createButton")}</> : <><Check className="mr-1 h-3.5 w-3.5" /> {t("common.save")}</>}
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
          <SelectTrigger id="voice-mms-lang" className="w-full">
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
            placeholder="ita"
            className="font-mono"
          />
        </Field>
      )}
    </>
  )
}
