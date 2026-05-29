// CharacterModal: the focused "character creator" — crafting a character voice
// should feel like making a character in a game's character creator, not poking
// at an always-open inspector. A show often has ONE voice actor; characters are
// how that single actor becomes many distinct voices.
//
// One mental model: every character just has a VOICE SOURCE — either a PRESET
// engine voice, OR a REFERENCE recording (record/upload a clip, or lift a take
// from an existing line). A character WITH a reference (referenceAudioId set) is
// what we used to call a "clone": its TTS output gets re-voiced into that timbre
// via Seed-VC. There is no separate "clone" concept anymore.
//
// All knobs that used to be separate (accent / pronunciation reference / prompt)
// collapse into ONE free-text "Guidance" field, stored on Voice.prompt so it
// flows through the existing Gemini prompt path (gemini-tts.ts reads voice.prompt
// as the template; plain guidance text is treated as the prompt body).

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check, Loader2, Pause, Play, Star, Trash2,
} from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import { GEMINI_TTS_VOICES } from "@/lib/audio/gemini-tts"
import { newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
import { synthesizeToWavBlob } from "@/lib/audio/tts"
import { normalizeVoiceForProvider, defaultVoiceNameForProvider } from "@/lib/audio/tts-providers"
import {
  HAS_EXTENDED_MMS_MODELS, POPULAR_MMS_LANGUAGES,
} from "@/lib/audio/mms-languages"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import { parseFrontierAudioUrl, fetchCellAudio } from "@/lib/audio/upload"
import { VoiceCloneSection } from "@/components/VoiceCloneSection"

const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog."

export interface CharacterModalProps {
  open: boolean
  onClose: () => void
  /** The character being edited; null = creating a brand-new one. */
  voice: Voice | null
  provider: NonNullable<ProjectTtsSettings["provider"]>
  apiKey: string
  targetLanguage?: string
  isDefault: boolean
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  /** Cells with audio, for the "use a take from a line" reference source. */
  cells: CellData[]
  /** Persist this character (create or update). */
  onSave: (voice: Voice) => void
  onDelete?: () => void
  onMakeDefault?: () => void
  /** When creating from a specific cell's take, preselect Reference + that take. */
  seedCellId?: string | null
}

type Source = "preset" | "reference"

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "playing" }
  | { kind: "error"; message: string }

interface TakeSource {
  cell: CellData
  slot: "recorded" | "generated"
  audioId: string
}

const slotUrl = (cell: CellData, audioId: string): string | undefined =>
  cell.attachments?.[audioId]?.url

const takeKey = (t: TakeSource): string => `${t.cell.id}:${t.slot}`

/** Short readable snippet for a cell, preferring translated then original. */
function cellSnippet(cell: CellData): string {
  const raw = (cell.translated || cell.original || cell.cellLabel || cell.id).trim()
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw || cell.id
}

/** Every (cell, slot) pair on these cells that actually has audio bytes. */
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

export function CharacterModal(props: CharacterModalProps) {
  // Seed local edit state fresh each open: mount the body keyed on the voice id
  // (or "new") so a lazy initializer can read props.voice without an effect.
  if (!props.open) return null
  return (
    <CharacterModalBody
      key={`${props.voice?.id ?? "new"}:${props.seedCellId ?? ""}`}
      {...props}
    />
  )
}

function CharacterModalBody({
  onClose, voice, provider, apiKey, targetLanguage, isDefault,
  projectId, fileId, session, cells, onSave, onDelete, onMakeDefault, seedCellId,
}: CharacterModalProps) {
  const isNew = voice === null

  // The character under construction — committed only via onSave.
  const [draft, setDraft] = useState<Voice>(() =>
    voice ?? {
      id: newVoiceId(),
      name: "New character",
      color: VOICE_PALETTE[0],
      provider,
      voiceName: defaultVoiceNameForProvider(provider, { targetLanguage }),
      builtIn: false,
    },
  )

  const [sourceMode, setSourceMode] = useState<Source>(() =>
    voice?.referenceAudioId || seedCellId ? "reference" : "preset",
  )

  const update = useCallback((patch: Partial<Voice>) => {
    setDraft((cur) => ({ ...cur, ...patch }))
  }, [])

  // ── Preview ───────────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const previewUrlRef = useRef<string | null>(null)

  const stopPreview = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }
    setPreview({ kind: "idle" })
  }, [])

  useEffect(() => stopPreview, [stopPreview])

  const effectiveVoice = useMemo(
    () => normalizeVoiceForProvider(draft, provider, { targetLanguage }),
    [draft, provider, targetLanguage],
  )

  const handlePreview = useCallback(async () => {
    if (preview.kind === "playing") { stopPreview(); return }
    if (provider === "gemini" && !apiKey.trim()) {
      setPreview({ kind: "error", message: "Add a Gemini API key in the engine settings to test voices." })
      return
    }
    setPreview({ kind: "loading" })
    try {
      const blob = await synthesizeToWavBlob(SAMPLE_TEXT, {
        voice: effectiveVoice,
        projectProvider: provider,
        apiKey,
        geminiContext: { targetLanguage },
      })
      const url = URL.createObjectURL(blob)
      previewUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = stopPreview
      audio.onpause = () => {
        if (audioRef.current === audio) setPreview((p) => p.kind === "playing" ? { kind: "idle" } : p)
      }
      setPreview({ kind: "playing" })
      await audio.play()
    } catch (e) {
      setPreview({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [preview.kind, provider, apiKey, effectiveVoice, targetLanguage, stopPreview])

  // ── "Use a take from a line" ────────────────────────────────────────────
  const takes = useMemo(() => audioSources(cells), [cells])
  const [takeBusy, setTakeBusy] = useState(false)
  const [takeError, setTakeError] = useState<string | null>(null)

  const useTake = useCallback(async (take: TakeSource) => {
    if (!projectId) {
      setTakeError("No project context to lift a take.")
      return
    }
    const url = slotUrl(take.cell, take.audioId)
    const parsed = url ? parseFrontierAudioUrl(url) : null
    if (!parsed) {
      setTakeError("That audio is no longer available.")
      return
    }
    setTakeBusy(true)
    setTakeError(null)
    try {
      const getSyncToken = audioSyncTokenFetcherForSession(session ?? null)
      const bytes = await fetchCellAudio({
        projectId,
        fileId: take.cell.fileId,
        audioId: parsed.audioId,
        ext: parsed.ext,
        getSyncToken,
      })
      const blob = new Blob([bytes as BlobPart], { type: mimeForExt(parsed.ext) })
      const referenceAudioId = buildVoiceReferenceId(parsed.ext)
      await uploadVoiceReference({
        projectId,
        fileId: take.cell.fileId,
        referenceAudioId,
        blob,
        getSyncToken,
      })
      update({ referenceAudioId })
    } catch (e) {
      setTakeError(e instanceof Error ? e.message : String(e))
    } finally {
      setTakeBusy(false)
    }
  }, [projectId, session, update])

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = useCallback(() => {
    // Drop a stale reference when the character is a plain preset voice.
    const next: Voice = sourceMode === "preset"
      ? { ...draft, referenceAudioId: undefined }
      : draft
    onSave(next)
    onClose()
  }, [draft, sourceMode, onSave, onClose])

  const isGemini = provider === "gemini"
  const isMms = provider === "mms"

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <h2 className="font-heading text-base font-medium">
          {isNew ? "Craft character" : "Edit character"}
        </h2>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
          {/* Name + color */}
          <div className="flex items-center gap-2">
            <ColorDot color={draft.color} onPick={(c) => update({ color: c })} />
            <Input
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              className="h-9 min-w-0 flex-1 font-medium"
              placeholder="Character name"
              aria-label="Character name"
            />
          </div>

          {/* Voice source */}
          <div className="space-y-2">
            <Label>Voice source</Label>
            <div className="grid grid-cols-2 gap-1.5">
              <SourceTab
                active={sourceMode === "preset"}
                onClick={() => setSourceMode("preset")}
                label="Preset"
                hint="An engine voice"
              />
              <SourceTab
                active={sourceMode === "reference"}
                onClick={() => setSourceMode("reference")}
                label="Reference"
                hint="A recorded timbre"
              />
            </div>
          </div>

          {sourceMode === "preset" ? (
            <PresetPicker
              isGemini={isGemini}
              isMms={isMms}
              value={effectiveVoice.voiceName ?? ""}
              onChange={(v) => update({ voiceName: v || undefined })}
            />
          ) : (
            <div className="space-y-3">
              <VoiceCloneSection
                voice={draft}
                projectId={projectId}
                fileId={fileId}
                session={session}
                onChange={update}
              />
              {takes.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Or use a take from a line</Label>
                  <div className="max-h-40 space-y-1 overflow-auto rounded-lg border bg-muted/20 p-1">
                    {takes.map((t) => {
                      const seeded = seedCellId != null && t.cell.id === seedCellId
                      return (
                        <button
                          key={takeKey(t)}
                          type="button"
                          onClick={() => void useTake(t)}
                          disabled={takeBusy}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50",
                            seeded ? "border-primary bg-primary/10" : "border-transparent hover:bg-accent/40",
                          )}
                        >
                          <span className="truncate">{cellSnippet(t.cell)}</span>
                          <span
                            className={cn(
                              "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                              t.slot === "recorded" ? "bg-emerald-500/15" : "bg-indigo-500/15",
                            )}
                          >
                            {t.slot === "recorded" ? "Recorded" : "Generated"}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {takeBusy && (
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Lifting take…
                    </p>
                  )}
                  {takeError && (
                    <p className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                      {takeError}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Guidance — the single free-text knob; routes to Voice.prompt. */}
          <div className="space-y-1.5">
            <Label htmlFor="character-guidance">Guidance</Label>
            <textarea
              id="character-guidance"
              value={draft.prompt ?? ""}
              onChange={(e) => update({ prompt: e.target.value || undefined })}
              rows={3}
              className="w-full rounded border bg-muted/20 px-3 py-2 text-sm"
              placeholder="calm, warm, elderly; coastal Swahili reading"
            />
            <p className="text-xs text-muted-foreground">
              Describe how this character should sound and read. Shapes generation.
            </p>
          </div>

          {/* Preview */}
          <div className="space-y-1.5">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handlePreview()}
              disabled={preview.kind === "loading"}
              className="w-full"
            >
              {preview.kind === "loading" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                : preview.kind === "playing" ? <Pause className="mr-1 h-4 w-4" />
                : <Play className="mr-1 h-4 w-4" />}
              {preview.kind === "playing" ? "Stop preview" : "Preview voice"}
            </Button>
            {preview.kind === "error" && (
              <p className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {preview.message}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="-mx-5 -mb-5 mt-1 flex flex-wrap items-center gap-2 rounded-b-3xl bg-muted/40 p-5">
          {onMakeDefault && !isDefault && (
            <Button type="button" size="sm" variant="outline" onClick={onMakeDefault}>
              <Star className="mr-1 h-3.5 w-3.5" /> Make default
            </Button>
          )}
          {isDefault && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Star className="h-3.5 w-3.5 text-primary" /> Default character
            </span>
          )}
          {onDelete && !draft.builtIn && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => { onDelete(); onClose() }}
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={handleSave}>
              <Check className="mr-1 h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SourceTab({
  active, onClick, label, hint,
}: { active: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border px-3 py-2 text-left transition-colors",
        active ? "border-primary bg-primary/10" : "hover:bg-accent/40",
      )}
    >
      <span className="block text-sm font-medium">{label}</span>
      <span className="block text-[11px] text-muted-foreground">{hint}</span>
    </button>
  )
}

function PresetPicker({
  isGemini, isMms, value, onChange,
}: { isGemini: boolean; isMms: boolean; value: string; onChange: (v: string) => void }) {
  if (isMms) {
    const knownCode = POPULAR_MMS_LANGUAGES.some((l) => l.code === value)
    const selectValue = knownCode ? value : HAS_EXTENDED_MMS_MODELS ? "__other__" : ""
    return (
      <div className="space-y-3">
        <div>
          <Label htmlFor="character-mms-lang">Language</Label>
          <select
            id="character-mms-lang"
            value={selectValue}
            onChange={(e) => {
              const next = e.target.value
              onChange(next === "__other__" ? "" : next)
            }}
            className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
          >
            {!knownCode && !HAS_EXTENDED_MMS_MODELS && (
              <option value="" disabled>
                {value ? `Unsupported code: ${value}` : "Choose a language"}
              </option>
            )}
            {POPULAR_MMS_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.name} ({l.code})</option>
            ))}
            {HAS_EXTENDED_MMS_MODELS && <option value="__other__">Other MMS code</option>}
          </select>
        </div>
        {HAS_EXTENDED_MMS_MODELS && (
          <div>
            <Label htmlFor="character-mms-code">MMS code</Label>
            <Input
              id="character-mms-code"
              value={value}
              onChange={(e) => onChange(e.target.value.trim().toLowerCase())}
              placeholder="ita"
              className="mt-1 font-mono"
            />
          </div>
        )}
      </div>
    )
  }

  if (isGemini) {
    return (
      <div>
        <Label htmlFor="character-gemini-voice">Gemini voice</Label>
        <select
          id="character-gemini-voice"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded border bg-background px-3 py-2 text-sm"
        >
          {GEMINI_TTS_VOICES.map((v) => (
            <option key={v.name} value={v.name}>{v.name} — {v.description}</option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div>
      <Label htmlFor="character-kokoro-voice">Kokoro voice id</Label>
      <Input
        id="character-kokoro-voice"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. af_bella"
        className="mt-1 font-mono"
      />
    </div>
  )
}

function ColorDot({ color, onPick }: { color?: string; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Character color"
        className="h-9 w-9 rounded-full border"
        style={{ backgroundColor: color || "#94a3b8" }}
      />
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 grid grid-cols-6 gap-1 rounded-md border bg-popover p-1.5 shadow-md">
          {VOICE_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { onPick(c); setOpen(false) }}
              className="h-5 w-5 rounded-full border"
              style={{ backgroundColor: c }}
              aria-label={`Pick color ${c}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
