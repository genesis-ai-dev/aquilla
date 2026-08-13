// AQU-906 — the scene monitor inside the recording modal. Codex parity: a
// voice actor dubbing a line needs to SEE the shot they're recording against,
// so the linked video sits next to the transport, parked on the cell's own
// time window.
//
// Two rules make it safe to sit a few inches from a live microphone:
//   1. While the recorder is armed the video is FORCE-muted — an unmuted
//      speaker bleeds straight back into the take. The user's own mute
//      preference can't override that; it only applies between takes.
//   2. Playback is bounded by the cell's window. It seeks to `startSec` on
//      arm, and pauses itself at `endSec` instead of running on into the next
//      line's footage.
//
// No `controls`: this is a monitor slaved to the recorder's phase, not a
// transport the user drives. The timeline is where you scrub.

import { useCallback, useEffect, useRef, useState } from "react"
import { Volume2, VolumeX } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"

interface Props {
  src: string
  /** Cell window start, in seconds of raw video time. Null when the cell is untimed. */
  startSec: number | null
  /** Cell window end, in seconds. Null leaves playback unbounded. */
  endSec: number | null
  /** True while the recorder is armed (counting or recording) — drives play/pause
   *  and forces the mute. */
  recording: boolean
}

export function RecordingVideoStage({ src, startSec, endSec, recording }: Props) {
  const t = useT()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // The user's preference, honoured only between takes (see rule 1 above).
  const [userMuted, setUserMuted] = useState(false)
  const muted = recording || userMuted

  const seekToStart = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    try { v.currentTime = Math.max(0, startSec ?? 0) } catch { /* not seekable yet */ }
  }, [startSec])

  // Park on the cell's window whenever the cell (or the video) changes, so the
  // frame on screen is the one about to be dubbed.
  useEffect(() => { seekToStart() }, [seekToStart, src])

  // Follow the recorder's phase: arm → rewind to the window and roll; disarm →
  // stop and rewind so the next take starts from the same frame.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (recording) {
      seekToStart()
      void v.play().catch(() => { /* autoplay blocked — the take still records */ })
    } else {
      v.pause()
      seekToStart()
    }
  }, [recording, seekToStart])

  // Stop at the cell's end rather than drifting into the next line's footage.
  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current
    if (!v || endSec == null) return
    if (v.currentTime >= endSec) v.pause()
  }, [endSec])

  return (
    <div data-testid="rec-video-stage" className="w-full space-y-2">
      <div className="relative flex justify-center overflow-hidden rounded-md bg-black">
        <video
          ref={videoRef}
          src={src}
          data-testid="rec-video"
          muted={muted}
          playsInline
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          className="max-h-[240px] w-auto"
        />
        {/* The mute state has to be readable at a glance from the booth, not
            just inferable from the button — hence the badge on the frame. */}
        {muted && (
          <span
            data-testid="rec-video-muted-badge"
            className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white"
          >
            <VolumeX className="h-3 w-3" />
            {t("audio.recordingModal.videoMutedBadge")}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {recording
            ? t("audio.recordingModal.videoMutedWhileRecording")
            : t("audio.recordingModal.videoScenePreview")}
        </p>
        <AppTooltip
          content={
            recording
              ? t("audio.recordingModal.videoMutedWhileRecording")
              : userMuted
                ? t("audio.recordingModal.unmuteVideoTooltip")
                : t("audio.recordingModal.muteVideoTooltip")
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="rec-video-mute"
            // Between takes only: while armed the mute is not the user's to give away.
            disabled={recording}
            aria-pressed={muted}
            onClick={() => setUserMuted((v) => !v)}
            aria-label={
              userMuted
                ? t("audio.recordingModal.unmuteVideoTooltip")
                : t("audio.recordingModal.muteVideoTooltip")
            }
            className="text-muted-foreground/60"
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
        </AppTooltip>
      </div>
    </div>
  )
}
