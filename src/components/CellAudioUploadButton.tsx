// AQU-513: per-cell "upload audio file" affordance next to the mic record
// button. Oral teams record on phones and need to get an existing wav/mp3/
// m4a straight into a cell without a desktop — a plain `<input type="file">`
// works out of the box on mobile browsers (opens the file picker / camera
// roll / files app), no MediaRecorder support needed.
//
// Reuses the SAME upload+attach path as the mic recorder
// (AudioRecordingModal.save, ~:178-242): R2 PUT via uploadCellAudio, then
// cell.audio.attach via emitCellAudioAttach into slot "recording", then the
// optimistic-injection bus so `hasAudio` flips before the server round-trip.
//
// SWARM-TODO (live-UI QA): in the editor, on a cell action rail (a cell with
// no audio yet), click the new Upload-audio button next to the mic icon,
// pick a wav/mp3 file → the cell should flip to hasAudio (play button
// appears in place of mic+upload) and the clip should play back. Also
// spot-check on a real mobile browser (the picker should surface Files/
// camera-roll, not just desktop file dialogs).

import { useCallback, useRef, useState } from "react"
import { Upload } from "lucide-react"
import { RailButton } from "./CellActionRail"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { buildAudioId, deleteCellAudio, uploadCellAudio } from "@/lib/audio/upload"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { injectOptimisticAudioAttachment, notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { markProjectHasAudioDataSoon } from "@/lib/audio/project-audio-state"
import { probeDurationMsSafe } from "@/lib/import"

const ACCEPT = "audio/*,.wav,.mp3,.m4a,.ogg"

/** Extension for the R2 object name. Prefer the filename's own extension
 *  (wav/mp3/m4a survive that way); fall back to a mimeType guess, then a
 *  generic default so an upload never fails just because the ext is unclear. */
function extFromFile(file: File): string {
  const dot = file.name.lastIndexOf(".")
  if (dot > 0 && dot < file.name.length - 1) {
    const fromName = file.name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "")
    if (fromName) return fromName
  }
  const mime = file.type.toLowerCase()
  if (mime.includes("wav")) return "wav"
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3"
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a"
  if (mime.includes("ogg")) return "ogg"
  return "bin"
}

interface Props {
  projectId: string
  fileId: string
  cellId: string
  /** AQU-646: an uploaded take just landed. Lets the workspace give a text-less
   *  line a target row, so a recording counts as translated work. Same contract
   *  as the recorder modal's `onTakeSaved`. */
  onTakeSaved?: (cellId: string) => void
  /** Author attribution for the cell.audio.attach event. */
  username: string
  disabled?: boolean
}

export function CellAudioUploadButton({ projectId, fileId, cellId, username, disabled, onTakeSaved }: Props) {
  const { session } = useFrontierSession()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openPicker = useCallback(() => {
    if (disabled || uploading) return
    setError(null)
    inputRef.current?.click()
  }, [disabled, uploading])

  const handleFileSelected = useCallback(async (file: File) => {
    if (!session?.jwt) {
      setError("Sign in to upload recordings")
      return
    }
    setUploading(true)
    setError(null)
    const ext = extFromFile(file)
    const audioId = buildAudioId(cellId)
    try {
      const result = await uploadCellAudio({
        projectId,
        fileId,
        audioId,
        ext,
        blob: file,
        getSyncToken: audioSyncTokenFetcherForSession(session),
      })
      markProjectHasAudioDataSoon(projectId)
      const fullAudioId = `${result.audioId}.${result.ext}`
      // Round 6: carry the upload's duration so its Target-track chip renders
      // at the recording's real length. Best-effort.
      const uploadDurationMs = await probeDurationMsSafe(file)
      let attachEventId: string
      try {
        attachEventId = await emitCellAudioAttach({
          projectId,
          fileId,
          cellId,
          audioId: fullAudioId,
          url: result.url,
          slot: "recording",
          mimeType: file.type || undefined,
          durationMs: uploadDurationMs,
          author: username,
        })
      } catch (emitErr) {
        // Same orphan-cleanup as the mic recorder: the R2 object uploaded
        // fine but the attach event failed — delete it rather than leaking
        // storage, then re-throw so the user sees the real error.
        void deleteCellAudio({
          projectId,
          fileId,
          audioId: result.audioId,
          ext: result.ext,
          getSyncToken: audioSyncTokenFetcherForSession(session),
        })
        throw emitErr
      }
      // Flip `hasAudio` immediately — don't wait on the server round-trip.
      injectOptimisticAudioAttachment(fileId, cellId, {
        audioId: fullAudioId,
        url: result.url,
        slot: "recording",
        mimeType: file.type || null,
        voiceId: null,
        referenceAudioId: null,
        durationMs: uploadDurationMs ?? null,
        trimStartMs: null,
        trimEndMs: null,
      }, attachEventId)
      notifyAudioAttachmentsChanged(fileId)
      onTakeSaved?.(cellId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }, [session, projectId, fileId, cellId, username, onTakeSaved])

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset so selecting the same file again still fires onChange.
    e.target.value = ""
    if (file) void handleFileSelected(file)
  }, [handleFileSelected])

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={onInputChange}
        disabled={disabled || uploading}
        aria-label="Upload audio file"
      />
      <RailButton
        icon={<Upload className="h-3.5 w-3.5" />}
        tooltip={uploading ? "Uploading…" : "Upload audio file"}
        onClick={openPicker}
        disabled={disabled}
        pulsing={uploading}
      />
      {error && (
        <span
          role="tooltip"
          className="absolute bottom-full right-0 z-50 mb-1 w-52 rounded-md border bg-popover px-3 py-2 text-[11px] leading-snug text-popover-foreground shadow-md"
        >
          <strong className="block font-semibold">Upload failed</strong>
          <span className="mt-0.5 block text-muted-foreground">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="mt-1.5 text-[10px] underline text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </span>
      )}
    </div>
  )
}
