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
//
// Sam's D1 (2026-10-05): ONE card — a short title, one sentence, "Attach
// captions" as the one primary action, and "or use the original recording" as
// a quiet link to a second step that holds the upload and its explanation.
// "Open Media view" stays only for people who cannot attach captions: for them
// it is the one useful thing to do (watch the video, see where captions go);
// for a maintainer it would be a second button competing with the action the
// card exists for, and the view switcher is one row up anyway.
//
// Sam's D3 put the prompt on the timeline's Source text lane and left the
// Media view's Text pane one line pointing at it. On Oct 5 he asked for the
// same card there too, so both views draw it; the lane keeps its own prompt.

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
  /** Which view the card is in: "text" (the default), or "media" for the
   *  Text pane under the Media view's timeline. The card is the same in both;
   *  this only marks it. */
  placement?: "text" | "media"
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


/** The empty state's secondary actions are quiet grey text, so they carry a
 *  dashed underline all the time: without it nothing says they can be clicked
 *  (Sam, Oct 5 — "it is not otherwise clear that it is clickable"). */
const QUIET_LINK = "text-muted-foreground underline decoration-dashed underline-offset-4 hover:decoration-solid"
export function TimelineLinkedVideoEmpty({
  isYouTube,
  captionTracks,
  placement = "text",
  onAttachFile,
  onOpenMediaView,
  onAttachCaptions,
  onUseCaptionTrackAsRows,
}: TimelineLinkedVideoEmptyProps) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // The second step: uploading the original recording instead.
  const [recordingStep, setRecordingStep] = useState(false)

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

  const promotable = onUseCaptionTrackAsRows
    ? captionTracks.filter(track => track.canBecomeRows)
    : []
  const tracksLine = captionTracks.length > 0
    ? t("editor.media.linkedVideoCaptionsOn", {
      tracks: captionTracks.map(track => track.name).join(", "),
    })
    : null
  const promoteButtons = promotable.length > 0 && (
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
  )

  // Only someone who can attach is told that attaching makes rows; everyone
  // else keeps the sentence that says what will happen.
  const description = tracksLine
    ?? t(onAttachCaptions ? "editor.media.linkedVideoAttachHint" : "editor.media.linkedVideoNoCaptions")
  const captionAction = Boolean(onAttachCaptions) || promotable.length > 0
  const showRecordingStep = recordingStep && Boolean(onAttachFile)

  return (
    <div className="mx-auto w-full max-w-md px-4 py-10" data-testid="linked-video-empty" data-placement={placement}>
      <div
        className={cn(
          "flex flex-col items-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-muted",
        )}
        // Drop lands only on the recording step, where the card says what a
        // recording does — and never for a viewer, who must not get a drop
        // target that silently does nothing.
        onDragOver={showRecordingStep ? (e) => {
          e.preventDefault()
          setDragOver(true)
        } : undefined}
        onDragLeave={showRecordingStep ? () => setDragOver(false) : undefined}
        onDrop={showRecordingStep ? (e) => {
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
        ) : showRecordingStep ? (
          <>
            <Clapperboard className="mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">{t("editor.media.linkedVideoRecordingTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {/* AQU-1565 follow-up: only a YouTube picture keeps its own sound
                  after an upload and offers the sound menu to switch. */}
              {t(isYouTube ? "editor.media.linkedVideoUploadHint" : "editor.media.linkedVideoUploadHintGeneric")}
            </p>
            {isYouTube && (
              <p className="mt-1 text-xs text-muted-foreground">{t("editor.media.linkedVideoStudioVideo")}</p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("editor.media.dropHint")}</p>
            <Button className="mt-2" nativeButton={false} render={<label />}>
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
            <Button variant="link" size="sm" className={cn("mt-2", QUIET_LINK)}
              onClick={() => { setRecordingStep(false); setError(null) }}>
              {t("editor.media.linkedVideoBackToCaptions")}
            </Button>
          </>
        ) : (
          <>
            <Clapperboard className="mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {t(isYouTube ? "editor.media.linkedVideoTitle" : "editor.media.linkedVideoTitleGeneric")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
            {/* Aquilla can't take a YouTube video's captions; its owner can. */}
            {isYouTube && onAttachCaptions && !tracksLine && (
              <p className="mt-1 text-xs text-muted-foreground">{t("editor.media.linkedVideoStudioCaptions")}</p>
            )}
            {promoteButtons}
            {onAttachCaptions ? (
              <Button className="mt-3" variant={promotable.length > 0 ? "outline" : "default"} onClick={onAttachCaptions}>
                {t("importExport.captionTrack.attach")}
              </Button>
            ) : !captionAction && onOpenMediaView ? (
              <Button className="mt-3" variant="outline" onClick={onOpenMediaView}>
                {t("editor.media.openMediaView")}
              </Button>
            ) : null}
            {onAttachFile && (
              <Button variant="link" size="sm" className={cn("mt-1", QUIET_LINK)}
                onClick={() => { setRecordingStep(true); setError(null) }}>
                {t(captionAction || onOpenMediaView ? "editor.media.linkedVideoUseRecording" : "editor.media.linkedVideoAddRecording")}
              </Button>
            )}
          </>
        )}
      </div>

      {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
    </div>
  )
}
