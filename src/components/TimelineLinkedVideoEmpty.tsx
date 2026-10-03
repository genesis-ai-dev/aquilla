// AQU-1565: the empty table for a time-ordered file whose media is a LINKED
// video (a YouTube "Link video only" import) and which has no rows yet.
//
// TimelineAddMedia — the prompt this replaces for such a file — says "No media
// on this file yet" and offers a direct-media-URL field. Both are wrong here:
// the file's video is linked and playing in the Media view, and that field
// rejects a YouTube watch page, which is the only link the user has. What the
// file is missing is CAPTIONS, and captions are attached on the Media view's
// timeline, so that is where this points.
//
// AQU-1566 (Sam's option b): the first captions on such a file become its OWN
// rows, the same as captions added at import time. So a maintainer gets
// "Attach captions" right here (no track-editing switch needed), and a file
// that already has a caption track on its timeline (made before this) gets one
// "Use (track) as this file's rows" button per track.
//
// Uploading the original recording is still offered, because a recording with
// the same timing as the linked video does produce rows for this file. It is
// stored as the file's source audio, and a YouTube video keeps its own sound
// until the person picks the recording. Only people who can add rows and set
// source audio get the offer; a viewer gets the sentence and nothing else.

import { useState } from "react"
import { Clapperboard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { detectFileType, isMediaFileType } from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"
import type { LinkedVideoCaptionTrack } from "@/lib/editor/linked-video-empty-state"

/** Same audio/video extensions TimelineAddMedia and the Import dialog take. */
const MEDIA_FILE_ACCEPT = ".mp3,.wav,.m4a,.aac,.flac,.ogg,.oga,.opus,.mp4,.m4v,.mov,.webm,.mkv"

interface TimelineLinkedVideoEmptyProps {
  /** Name the link for what it is — a YouTube video, or just a video. */
  isYouTube: boolean
  /** Caption tracks already on this file's timeline. Non-empty ⇒ the file has
   *  captions, so the copy names them instead of claiming it has none. */
  captionTracks: readonly LinkedVideoCaptionTrack[]
  /** Upload the original recording as this file's media. Absent ⇒ read-only. */
  onAttachFile?: (file: File) => Promise<void>
  /** Switch this file to the Media view. Absent when already there. */
  onOpenMediaView?: () => void
  /** AQU-1566: open the caption dialog in rows mode. Absent below maintainer. */
  onAttachCaptions?: () => void
  /** AQU-1566: turn an attached caption track into this file's rows (the
   *  workspace asks first). Absent below maintainer. */
  onUseCaptionTrackAsRows?: (trackId: string) => void
}

export function TimelineLinkedVideoEmpty({
  isYouTube,
  captionTracks,
  onAttachFile,
  onOpenMediaView,
  onAttachCaptions,
  onUseCaptionTrackAsRows,
}: TimelineLinkedVideoEmptyProps) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const attachFile = async (file: File) => {
    if (!onAttachFile) return
    const type = detectFileType(file.name)
    if (!type || !isMediaFileType(type)) {
      setError(`"${file.name}" isn't a supported audio/video format.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onAttachFile(file)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const description = captionTracks.length > 0
    ? t("editor.media.linkedVideoCaptionsOn", {
      tracks: captionTracks.map(track => track.name).join(", "),
    })
    // Only someone who can attach is told that attaching makes rows; everyone
    // else keeps the sentence that says where captions live.
    : t(onAttachCaptions ? "editor.media.linkedVideoAttachHint" : "editor.media.linkedVideoNoCaptions")
  const promotable = onUseCaptionTrackAsRows
    ? captionTracks.filter(track => track.canBecomeRows)
    : []

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10" data-testid="linked-video-empty">
      <div
        className={cn(
          "flex flex-col items-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-muted",
        )}
        // Drop only lands when uploading is actually on offer — a viewer must
        // not get a drop target that silently does nothing.
        onDragOver={onAttachFile ? (e) => {
          e.preventDefault()
          setDragOver(true)
        } : undefined}
        onDragLeave={onAttachFile ? () => setDragOver(false) : undefined}
        onDrop={onAttachFile ? (e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files?.[0]
          if (file && !busy) void attachFile(file)
        } : undefined}
      >
        {busy ? (
          <p className="flex items-center gap-2 text-sm font-medium">
            <Spinner /> {t("editor.media.adding")}
          </p>
        ) : (
          <>
            <Clapperboard className="mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {t(isYouTube ? "editor.media.linkedVideoTitle" : "editor.media.linkedVideoTitleGeneric")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            {promotable.length > 0 && (
              <div className="mt-3 flex flex-col items-center gap-2">
                {promotable.map(track => (
                  // Wraps: a track name runs to 120 characters, and a one-line
                  // button would spill out of this column.
                  <Button key={track.id} className="h-auto max-w-full whitespace-normal py-1.5 text-center"
                    onClick={() => onUseCaptionTrackAsRows?.(track.id)}>
                    {t("editor.media.useTrackAsRows", { track: track.name })}
                  </Button>
                ))}
                {/* Only worth saying when there is another track to stay. */}
                {captionTracks.length > 1 && (
                  <p className="text-xs text-muted-foreground">{t("editor.media.useTrackAsRowsHint")}</p>
                )}
              </div>
            )}
            {(onAttachCaptions || onOpenMediaView) && (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {onAttachCaptions && (
                  // Primary until a track is there to promote; then that is
                  // the main way in and this is the alternative.
                  <Button variant={promotable.length > 0 ? "outline" : "default"} onClick={onAttachCaptions}>
                    {t("importExport.captionTrack.attach")}
                  </Button>
                )}
                {onOpenMediaView && (
                  <Button variant="outline" onClick={onOpenMediaView}>
                    {t("editor.media.openMediaView")}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {onAttachFile && !busy && (
        <div className="mt-3 text-center">
          <p className="text-xs text-muted-foreground">{t("editor.media.linkedVideoUpload")}</p>
          <Button variant="outline" className="mt-2" nativeButton={false} render={<label />}>
            {t("editor.media.choose")}
            <input
              type="file"
              className="hidden"
              accept={MEDIA_FILE_ACCEPT}
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ""
                if (file) void attachFile(file)
              }}
            />
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {/* AQU-1565 follow-up: only a YouTube picture keeps its own sound
                after an upload and offers the sound menu to switch. */}
            {t(isYouTube ? "editor.media.linkedVideoUploadHint" : "editor.media.linkedVideoUploadHintGeneric")}
          </p>
        </div>
      )}

      {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
    </div>
  )
}
