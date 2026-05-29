// CloneVoiceDialog: clone a brand-new "actor" voice from audio that already
// exists on a cell — either a human recording (selectedAudioId) or a previous
// TTS render (selectedGeneratedVoiceAudioId). This is distinct from the
// fresh-recording clone in VoiceLibraryPanel/VoiceCloneSection: here the
// reference timbre is lifted from existing project audio rather than the mic.
//
// Flow: pick a cell + slot -> fetch that slot's audio bytes (fetchCellAudio)
// -> upload them as a project-scoped reference clip (uploadVoiceReference) ->
// append a new Voice with referenceAudioId set so future TTS for that voice
// gets re-voiced into this timbre via Seed-VC.

import { useCallback, useMemo, useState } from "react"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import { newVoiceId, VOICE_PALETTE, getVoiceLibrary } from "@/lib/audio/voices"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import { parseFrontierAudioUrl, fetchCellAudio } from "@/lib/audio/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"

export interface CloneVoiceDialogProps {
  open: boolean
  onClose: () => void
  cells: CellData[]
  settings: ProjectTtsSettings
  projectId: string
  /** Needed to mint sync tokens for the R2 fetch + reference upload. */
  session: FrontierSession | null
  /** = useProjectTts.saveTts; we append the new cloned Voice. */
  onSave: (next: ProjectTtsSettings) => void
}

type Slot = "recorded" | "generated"

interface AudioSource {
  cell: CellData
  slot: Slot
  audioId: string
}

/** The frontier-audio:// url for a given slot, read off the cell attachments. */
function slotUrl(cell: CellData, audioId: string): string | undefined {
  return cell.attachments?.[audioId]?.url
}

/** Short readable snippet for a cell, preferring translated then original. */
function cellSnippet(cell: CellData): string {
  const raw = (cell.translated || cell.original || cell.cellLabel || cell.id).trim()
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw || cell.id
}

/** Pick a palette color not already used by an existing voice, else cycle. */
function nextColor(settings: ProjectTtsSettings): string {
  const used = new Set(getVoiceLibrary(settings).map((v) => v.color).filter(Boolean))
  return VOICE_PALETTE.find((c) => !used.has(c)) ?? VOICE_PALETTE[0]
}

export function CloneVoiceDialog({
  open,
  onClose,
  cells,
  settings,
  projectId,
  session,
  onSave,
}: CloneVoiceDialogProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [color, setColor] = useState<string>(() => nextColor(settings))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Every (cell, slot) pair that actually has audio bytes behind it.
  const sources = useMemo<AudioSource[]>(() => {
    const out: AudioSource[] = []
    for (const cell of cells) {
      if (cell.selectedAudioId && slotUrl(cell, cell.selectedAudioId)) {
        out.push({ cell, slot: "recorded", audioId: cell.selectedAudioId })
      }
      if (
        cell.selectedGeneratedVoiceAudioId &&
        slotUrl(cell, cell.selectedGeneratedVoiceAudioId)
      ) {
        out.push({ cell, slot: "generated", audioId: cell.selectedGeneratedVoiceAudioId })
      }
    }
    return out
  }, [cells])

  const keyFor = (s: AudioSource) => `${s.cell.id}:${s.slot}`
  const selected = sources.find((s) => keyFor(s) === selectedKey) ?? null

  const reset = useCallback(() => {
    setSelectedKey(null)
    setName("")
    setColor(nextColor(settings))
    setBusy(false)
    setError(null)
  }, [settings])

  const handleClose = useCallback(() => {
    if (busy) return
    reset()
    onClose()
  }, [busy, reset, onClose])

  const handleConfirm = useCallback(async () => {
    if (!selected) return
    const url = slotUrl(selected.cell, selected.audioId)
    const parsed = url ? parseFrontierAudioUrl(url) : null
    if (!parsed) {
      setError("That audio is no longer available.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const getSyncToken = audioSyncTokenFetcherForSession(session)
      // Pull the existing clip's bytes back from R2, then re-upload them as a
      // project-scoped reference clip the new Voice points at.
      const bytes = await fetchCellAudio({
        projectId,
        fileId: selected.cell.fileId,
        audioId: parsed.audioId,
        ext: parsed.ext,
        getSyncToken,
      })
      const mime =
        parsed.ext === "webm" ? "audio/webm"
        : parsed.ext === "mp3" ? "audio/mpeg"
        : parsed.ext === "mp4" || parsed.ext === "m4a" ? "audio/mp4"
        : parsed.ext === "wav" ? "audio/wav"
        : "application/octet-stream"
      const blob = new Blob([bytes as BlobPart], { type: mime })
      const referenceAudioId = buildVoiceReferenceId(parsed.ext)
      await uploadVoiceReference({
        projectId,
        fileId: selected.cell.fileId,
        referenceAudioId,
        blob,
        getSyncToken,
      })
      const newVoice: Voice = {
        id: newVoiceId(),
        name: name.trim() || `Clone of ${cellSnippet(selected.cell)}`,
        color,
        provider: settings.provider ?? "gemini",
        voiceName: "",
        referenceAudioId,
        builtIn: false,
      }
      // getVoiceLibrary returns the presets when nothing is stored yet; persist
      // the full resolved list so the new clone lands alongside them.
      const base = getVoiceLibrary(settings)
      onSave({ ...settings, voices: [...base, newVoice] })
      reset()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed")
      setBusy(false)
    }
  }, [selected, projectId, session, name, color, settings, onSave, reset, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={handleClose}
    >
      <div
        className="neu-flat w-full max-w-md space-y-3 rounded-xl bg-popover p-4 text-popover-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Clone a voice from existing audio</h2>
          <button
            type="button"
            className="text-xs opacity-60 hover:opacity-100"
            onClick={handleClose}
            disabled={busy}
          >
            Close
          </button>
        </div>

        <p className="text-xs opacity-70">
          Pick a line that already has audio. Its timbre becomes a new cast voice.
        </p>

        {sources.length === 0 ? (
          <div className="neu-inset rounded-lg p-3 text-xs opacity-70">
            No cells have recorded or generated audio yet.
          </div>
        ) : (
          <div className="neu-inset max-h-48 space-y-1 overflow-auto rounded-lg p-1">
            {sources.map((s) => {
              const k = keyFor(s)
              const active = k === selectedKey
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSelectedKey(k)}
                  disabled={busy}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                    active ? "shadow-neu-xs neu-flat" : "hover:bg-black/5"
                  }`}
                >
                  <span className="truncate">{cellSnippet(s.cell)}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                      s.slot === "recorded" ? "bg-emerald-500/15" : "bg-indigo-500/15"
                    }`}
                  >
                    {s.slot === "recorded" ? "Recorded" : "Generated"}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-xs opacity-70">Voice name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mary, Narrator clone"
              disabled={busy}
              className="neu-inset w-full rounded-md px-2 py-1.5 text-xs outline-none"
            />
          </label>

          <div className="flex items-center gap-1.5">
            <span className="text-xs opacity-70">Color</span>
            {VOICE_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                disabled={busy}
                aria-label={`color ${c}`}
                className={`h-4 w-4 rounded-full ${color === c ? "ring-2 ring-offset-1" : ""}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {error ? <div className="text-xs text-red-500">{error}</div> : null}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs opacity-70 hover:opacity-100 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy || !selected}
            className="neu-flat shadow-neu-xs rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          >
            {busy ? "Cloning…" : "Create cloned voice"}
          </button>
        </div>
      </div>
    </div>
  )
}
