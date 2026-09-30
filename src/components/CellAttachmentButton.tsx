// AQU-777: the cell action rail's paperclip. Opens a file picker; the picked
// file is uploaded and attached to this cell.
//
// A near-twin of CellAudioUploadButton (AQU-513), and deliberately so — a
// plain hidden `<input type="file">` is what makes this work on a phone
// browser (it opens Files / the camera roll), and the anchored error popover
// is the rail's established way to report a failed upload without stealing
// focus from the row.
//
// Presentation only. The validate → PUT → emit → orphan-cleanup sequence lives
// in `@/lib/attachments/attach-file`, shared with any future caller so the two
// cannot drift the way the audio pair did before AQU-646 stage 5 extracted it.

import { useCallback, useRef, useState } from "react"
import { Paperclip } from "lucide-react"
import { RailButton } from "./CellActionRail"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { ACCEPT, attachFileToCell } from "@/lib/attachments/attach-file"
import type { CellAttachmentRecord } from "@/lib/sync/cell-attachments-read-types"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  projectId: string
  fileId: string
  cellId: string
  /** Author attribution for the cell.attachment.add event. */
  username: string
  /** Live attachment count on this cell — drives the tooltip and the dot. */
  attachmentCount?: number
  disabled?: boolean
  /** Fired once the attach lands, with a record shaped like the server's so
   *  the caller can show the link before the outbox flush completes. */
  onAttached?: (record: CellAttachmentRecord) => void
}

export function CellAttachmentButton({
  projectId,
  fileId,
  cellId,
  username,
  attachmentCount = 0,
  disabled,
  onAttached,
}: Props) {
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
      setError(t("editor.attachments.signIn"))
      return
    }
    setUploading(true)
    setError(null)
    try {
      const result = await attachFileToCell({
        session,
        projectId,
        fileId,
        cellId,
        file,
        username,
      })
      onAttached?.({
        attachmentId: result.attachmentId,
        projectId,
        fileId,
        cellId,
        objectName: result.objectName,
        name: result.name,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        authorId: username,
        authorLabel: username,
        // The server stamps the real createdAt; this local one only has to
        // sort the record last within its cell until the refresh lands.
        createdAt: Date.now(),
        cellRef: null,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }, [session, projectId, fileId, cellId, username, onAttached, t])

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset so picking the same file again still fires onChange. Also the
    // reason cancelling the picker creates nothing: no change event fires at
    // all, so there is no empty/orphan attachment to clean up.
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
        aria-label={t("editor.attachments.attach")}
      />
      <RailButton
        icon={<Paperclip className="h-3.5 w-3.5" />}
        tooltip={
          uploading
            ? t("common.uploading")
            : attachmentCount > 0
              ? t("editor.attachments.countTooltip", { count: attachmentCount })
              : t("editor.attachments.attach")
        }
        onClick={openPicker}
        disabled={disabled}
        pulsing={uploading}
        toneClass={attachmentCount > 0 ? "text-primary hover:text-primary" : undefined}
        dot={attachmentCount > 0 ? "primary" : undefined}
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
