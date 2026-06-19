// NewVoiceModal — one modal, two ways to make a voice:
//   • Gemini voice — name it + describe how it sounds. The base timbre is a
//     smart default (rotated so each new voice sounds distinct), so the form is
//     just Name + Describe — nothing else to fiddle with.
//   • Clone voice — name it + capture a short reference clip (record, upload, or
//     reuse a take already in the project). Generation is re-voiced to match it.
//
// Editing an existing voice reuses this same modal, locked to the voice's kind.
// Deliberately de-purpled: Gemini uses the brand accent, Clone uses emerald.

import { useCallback, useMemo, useState } from "react"
import { AudioLines, Check, Plus, Sparkles, Star, Trash2, UserRound } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import { VoiceCloneSection } from "@/components/VoiceCloneSection"
import { cn } from "@/lib/utils"
import { newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
import { GEMINI_TTS_VOICES, DEFAULT_GEMINI_VOICE } from "@/lib/audio/tts-providers"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import { parseFrontierAudioUrl, fetchCellAudio } from "@/lib/audio/upload"
import type { Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

type Mode = "gemini" | "clone"

export interface NewVoiceModalProps {
  open: boolean
  onClose: () => void
  /** Voice being edited; null = creating a new one. */
  voice: Voice | null
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
  onClose, voice, isDefault, paletteIndex, projectId, fileId, session, cells,
  onSave, onDelete, onMakeDefault, initialMode, seedCellId,
}: NewVoiceModalProps) {
  const isNew = voice === null
  const lockedMode: Mode | null = voice ? (voice.referenceAudioId ? "clone" : "gemini") : null
  const [mode, setMode] = useState<Mode>(lockedMode ?? initialMode ?? "gemini")

  const [draft, setDraft] = useState<Voice>(() =>
    voice ?? {
      id: newVoiceId(),
      name: "",
      color: VOICE_PALETTE[paletteIndex % VOICE_PALETTE.length],
      provider: "gemini",
      // Smart default: rotate the base timbre so a fresh voice sounds distinct
      // without making the user pick one.
      voiceName: GEMINI_TTS_VOICES[paletteIndex % GEMINI_TTS_VOICES.length]?.name ?? DEFAULT_GEMINI_VOICE,
    },
  )
  const update = useCallback((patch: Partial<Voice>) => setDraft((d) => ({ ...d, ...patch })), [])
  const [deleteOpen, setDeleteOpen] = useState(false)

  // ── Clone: reuse a take already in the project ──────────────────────────────
  const takes = useMemo(() => {
    const all = audioSources(cells)
    return [...all.filter((t) => t.slot === "recorded"), ...all.filter((t) => t.slot === "generated")]
  }, [cells])
  const seededTakePresent = seedCellId != null && takes.some((t) => t.cell.id === seedCellId)
  const [takeBusy, setTakeBusy] = useState(false)
  const [takeError, setTakeError] = useState<string | null>(null)
  const applyTake = useCallback(async (take: TakeSource) => {
    if (!projectId) { setTakeError("No project context to lift a take."); return }
    const url = slotUrl(take.cell, take.audioId)
    const parsed = url ? parseFrontierAudioUrl(url) : null
    if (!parsed) { setTakeError("That audio is no longer available."); return }
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
  }, [projectId, session, update])

  const hasReference = Boolean(draft.referenceAudioId)
  const nameOk = draft.name.trim().length > 0
  const canSave = mode === "clone" ? nameOk && hasReference : nameOk

  const handleSave = useCallback(() => {
    const fallback = mode === "clone" ? "Cloned voice" : "New voice"
    onSave({ ...draft, name: draft.name.trim() || fallback })
    onClose()
  }, [mode, draft, onSave, onClose])

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="sm:max-w-md">
          {/* Header */}
          <h2 className="flex items-center gap-2.5 font-heading text-base font-medium">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/12 text-primary">
              <AudioLines className="h-4 w-4" />
            </span>
            {isNew ? "New voice" : "Edit voice"}
          </h2>

          <div className="space-y-4 pt-1">
            {/* Kind tabs — hidden while editing (a voice's kind is fixed). */}
            {isNew && (
              <div className="grid grid-cols-2 gap-1 rounded-xl border bg-muted/40 p-1">
                <TabButton
                  active={mode === "gemini"}
                  onClick={() => setMode("gemini")}
                  icon={Sparkles}
                  label="Gemini voice"
                  tone="primary"
                />
                <TabButton
                  active={mode === "clone"}
                  onClick={() => setMode("clone")}
                  icon={UserRound}
                  label="Clone voice"
                  tone="emerald"
                />
              </div>
            )}

            {/* Name */}
            <div className="space-y-1.5">
              <Label htmlFor="voice-name">Name</Label>
              <Input
                id="voice-name"
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                className="h-10"
                placeholder="e.g. Narrator"
                aria-label="Voice name"
                autoFocus
              />
            </div>

            {mode === "gemini" ? (
              /* Describe how it sounds → Gemini voice direction (Voice.prompt). */
              <div className="space-y-1.5">
                <Label htmlFor="voice-describe">Describe the voice</Label>
                <Textarea
                  id="voice-describe"
                  value={draft.prompt ?? ""}
                  onChange={(e) => update({ prompt: e.target.value || undefined })}
                  rows={3}
                  placeholder="e.g. a warm older man, calm and clear"
                />
              </div>
            ) : (
              /* Clone: capture a reference clip. */
              <div className="space-y-2">
                <Label>Reference audio</Label>
                <VoiceCloneSection
                  voice={draft}
                  projectId={projectId}
                  fileId={fileId}
                  session={session}
                  onChange={update}
                />
                <p className="text-xs text-muted-foreground">
                  A short clip is enough — we generate a base voice and clone it to match.
                </p>

                {/* Or reuse audio already in the project. */}
                {takes.length > 0 && (
                  <details open={seededTakePresent} className="rounded-lg border bg-muted/10">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                      Or reuse audio from a line
                    </summary>
                    <div className="space-y-1.5 px-3 pb-3">
                      <div className="max-h-40 space-y-1 overflow-auto rounded-lg border bg-muted/20 p-1">
                        {takes.map((t) => {
                          const seeded = seedCellId != null && t.cell.id === seedCellId
                          return (
                            <button
                              key={takeKey(t)}
                              type="button"
                              onClick={() => void applyTake(t)}
                              disabled={takeBusy}
                              className={cn(
                                "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors disabled:opacity-50",
                                seeded ? "border-emerald-500 bg-emerald-500/10" : "border-transparent hover:bg-accent/40",
                              )}
                            >
                              <span className="truncate">{cellSnippet(t.cell)}</span>
                              <span
                                className={cn(
                                  "shrink-0 rounded px-1.5 py-0.5 text-[10px]",
                                  t.slot === "recorded"
                                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {t.slot === "recorded" ? "Recorded" : "AI-generated"}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                      {takeBusy && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Spinner className="h-3.5 w-3.5" /> Lifting take…
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
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="-mx-5 -mb-5 mt-2 flex flex-wrap items-center gap-2 rounded-b-3xl bg-muted/40 p-5">
            {onMakeDefault && !isDefault && (
              <Button
                type="button" size="sm" variant="outline" onClick={onMakeDefault}
                title="Make this the narrator — used for lines without an explicit speaker."
              >
                <Star className="mr-1 h-3.5 w-3.5" /> Make narrator
              </Button>
            )}
            {isDefault && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Star className="h-3.5 w-3.5 text-primary" /> Narrator
              </span>
            )}
            {onDelete && !draft.builtIn && (
              <Button
                type="button" size="sm" variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button
                type="button" size="sm" onClick={handleSave} disabled={!canSave}
                title={canSave ? undefined : mode === "clone" ? "Name it and add a reference clip" : "Name the voice"}
              >
                {isNew ? <><Plus className="mr-1 h-3.5 w-3.5" /> Create voice</> : <><Check className="mr-1 h-3.5 w-3.5" /> Save</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {onDelete && (
        <ConfirmActionDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete voice"
          description={`Delete "${draft.name || "this voice"}"? This removes the voice for everyone in the project and cannot be undone.`}
          confirmLabel="Delete voice"
          checkboxLabel="I understand this deletes the voice for everyone in the project."
          variant="destructive"
          onConfirm={() => { onDelete(); onClose() }}
        />
      )}
    </>
  )
}

function TabButton({
  active, onClick, icon: Icon, label, tone,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Sparkles
  label: string
  tone: "primary" | "emerald"
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        !active && "text-muted-foreground hover:text-foreground",
        active && tone === "primary" && "bg-primary text-primary-foreground shadow-sm",
        active && tone === "emerald" && "bg-emerald-500 text-white shadow-sm",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )
}
