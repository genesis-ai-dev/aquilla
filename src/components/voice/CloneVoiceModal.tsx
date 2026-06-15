// CloneVoiceModal — the separate "clone a voice" workflow. Cloning is its own
// concept: capture a short reference recording (mic or upload, or reuse a take
// already in the project), name it, save. The saved voice carries a
// referenceAudioId, so its TTS output is re-voiced into that timbre via Seed-VC.
// Base timbre is a smart default (the reference drives the sound) — no picker.

import { useCallback, useMemo, useState } from "react"
import { Check, Sparkles } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { VoiceCloneSection } from "@/components/VoiceCloneSection"
import { cn } from "@/lib/utils"
import { newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
import { DEFAULT_GEMINI_VOICE } from "@/lib/audio/tts-providers"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import { parseFrontierAudioUrl, fetchCellAudio } from "@/lib/audio/upload"
import type { Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

export interface CloneVoiceModalProps {
  open: boolean
  onClose: () => void
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  cells: CellData[]
  /** Index used to pick a fresh palette color. */
  paletteIndex: number
  onSave: (voice: Voice) => void
  /** When opened from a line's take, preselect + highlight that take. */
  seedCellId?: string | null
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

export function CloneVoiceModal(props: CloneVoiceModalProps) {
  if (!props.open) return null
  return <CloneVoiceModalBody key={props.seedCellId ?? "new"} {...props} />
}

function CloneVoiceModalBody({
  onClose, projectId, fileId, session, cells, paletteIndex, onSave, seedCellId,
}: CloneVoiceModalProps) {
  const [draft, setDraft] = useState<Voice>(() => ({
    id: newVoiceId(),
    name: "Cloned voice",
    color: VOICE_PALETTE[paletteIndex % VOICE_PALETTE.length],
    provider: "gemini",
    voiceName: DEFAULT_GEMINI_VOICE,
  }))
  const update = useCallback((patch: Partial<Voice>) => setDraft((d) => ({ ...d, ...patch })), [])

  // Recorded (human) takes first — cloning AI-generated audio rarely helps.
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
  }, [projectId, fileId, session, update])

  const hasReference = Boolean(draft.referenceAudioId)
  const handleSave = useCallback(() => {
    if (!hasReference) return
    onSave({ ...draft, name: draft.name.trim() || "Cloned voice" })
    onClose()
  }, [hasReference, draft, onSave, onClose])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <h2 className="flex items-center gap-2 font-heading text-base font-medium">
          <Sparkles className="h-4 w-4 text-violet-500" /> Clone a voice
        </h2>
        <p className="text-xs text-muted-foreground">
          Capture a short reference clip of the voice you want — a few clear seconds is enough.
          Generation will be re-voiced to match it.
        </p>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 pt-1">
          {/* Name + avatar */}
          <div className="flex items-center gap-2.5">
            <VoiceAvatar voice={draft} size={36} />
            <Input
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              className="h-9 min-w-0 flex-1 font-medium"
              placeholder="Voice name"
              aria-label="Voice name"
            />
          </div>

          {/* Reference capture (record / upload). */}
          <VoiceCloneSection
            voice={draft}
            projectId={projectId}
            fileId={fileId}
            session={session}
            onChange={update}
          />

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
                          seeded ? "border-primary bg-primary/10" : "border-transparent hover:bg-accent/40",
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

        {/* Footer */}
        <div className="-mx-5 -mb-5 mt-2 flex items-center gap-2 rounded-b-3xl bg-muted/40 p-5">
          <div className="ml-auto flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="button" size="sm" onClick={handleSave} disabled={!hasReference} title={hasReference ? undefined : "Add a reference clip first"}>
              <Check className="mr-1 h-3.5 w-3.5" /> Save clone
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
