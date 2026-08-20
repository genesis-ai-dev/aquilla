// AQU-513: per-cell "upload audio file" affordance next to the mic record
// button. Oral teams record on phones and need to get an existing wav/mp3/
// m4a straight into a cell without a desktop — a plain `<input type="file">`
// works out of the box on mobile browsers (opens the file picker / camera
// roll / files app), no MediaRecorder support needed.
//
// Presentation only. The upload+attach flow lives in
// `@/lib/audio/attach-file` (AQU-646 stage 5), shared verbatim with the
// recording modal's own upload control so the R2 PUT → cell.audio.attach →
// orphan-cleanup → optimistic-inject sequence cannot drift between the two.
// This file owns the rail button, the hidden input, and the error popover;
// everything else it does is `await attachAudioFileToCell(...)`.
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
import { ACCEPT, attachAudioFileToCell } from "@/lib/audio/attach-file"
import { useT } from "@/lib/i18n/I18nProvider"

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
  const t = useT()
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
      setError(t("editor.audio.uploadSignIn"))
      return
    }
    setUploading(true)
    setError(null)
    try {
      // No `label`: this rail has no takes list to number against, and
      // fetching one to name a single icon click isn't worth the request.
      await attachAudioFileToCell({ session, projectId, fileId, cellId, file, username })
      onTakeSaved?.(cellId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }, [session, projectId, fileId, cellId, username, onTakeSaved, t])

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
        aria-label={t("editor.audio.upload")}
      />
      <RailButton
        icon={<Upload className="h-3.5 w-3.5" />}
        tooltip={uploading ? t("common.uploading") : t("editor.audio.upload")}
        onClick={openPicker}
        disabled={disabled}
        pulsing={uploading}
      />
      {error && (
        <span
          role="tooltip"
          className="absolute bottom-full end-0 z-50 mb-1 w-52 rounded-md border bg-popover px-3 py-2 text-[11px] leading-snug text-popover-foreground shadow-md"
        >
          <strong className="block font-semibold">{t("common.uploadFailed")}</strong>
          <span className="mt-0.5 block text-muted-foreground">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="mt-1.5 text-[10px] underline text-muted-foreground hover:text-foreground"
          >
            {t("common.dismiss")}
          </button>
        </span>
      )}
    </div>
  )
}
