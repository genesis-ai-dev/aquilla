import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import ReactPlayer from "react-player"
import { cn } from "@/lib/utils"

export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void
  getCurrentTime: () => number
  play: () => Promise<void>
  pause: () => void
}

export interface SubtitleCue {
  start: number   // seconds (in cue-space)
  end: number     // seconds (in cue-space)
  text: string    // display text (plain; may contain newlines)
}

interface VideoPlayerProps {
  src: string
  onTimeUpdate?: (seconds: number) => void  // receives playbackTime (raw, unadjusted)
  onDurationChange?: (seconds: number) => void
  /** Fixed pixel height. Omit to fill the parent (`h-full`) — used when the
   *  player sits inside a shadcn Resizable panel. */
  height?: number
  className?: string
  // Live subtitle overlay driven by our own rendering (bypasses YouTube's
  // built-in CC, which we can't disable for third-party content). Pass current
  // cues; the component picks the one matching the adjusted playback time.
  cues?: SubtitleCue[]
  // Offset applied between raw video time and cue-space time. Example:
  //   startOffset = 5 → cue "00:00:01" plays at video time 6s.
  // cueTime = videoTime - startOffset
  startOffset?: number
}

// Wraps react-player v3 and renders a custom subtitle overlay. We don't use
// <track> children because iframe-based players (YouTube, Vimeo) ignore them
// and render their own CC UI inside the iframe — which we can't style or hide
// from outside. Our overlay sits on top of the video and is always under our
// control.
export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  { src, onTimeUpdate, onDurationChange, height, className, cues, startOffset = 0 },
  ref
) {
  // ReactPlayer's ref forwards to an HTMLVideoElement-compatible object
  // (native <video> for files, or proxy elements like youtube-video-element
  // that mimic the HTMLVideoElement API for remote players).
  const playerRef = useRef<HTMLVideoElement>(null)
  const [playbackTime, setPlaybackTime] = useState(0)

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      if (playerRef.current) playerRef.current.currentTime = seconds
    },
    getCurrentTime() {
      return playerRef.current?.currentTime ?? 0
    },
    async play() {
      if (playerRef.current) {
        try { await playerRef.current.play() } catch { /* autoplay blocked */ }
      }
    },
    pause() {
      playerRef.current?.pause()
    },
  }), [])

  useEffect(() => {
    const p = playerRef.current
    if (!p) return
    function onTime() {
      const t = p!.currentTime
      setPlaybackTime(t)
      onTimeUpdate?.(t)
    }
    function onDur() { onDurationChange?.(p!.duration) }
    p.addEventListener("timeupdate", onTime)
    p.addEventListener("durationchange", onDur)
    return () => {
      p.removeEventListener("timeupdate", onTime)
      p.removeEventListener("durationchange", onDur)
    }
  }, [onTimeUpdate, onDurationChange])

  // Try to hide YouTube's built-in captions if present (best effort — YT
  // doesn't let us fully disable CC via public iframe API, but we can
  // visually hide the caption layer when in fullscreen mode stays internal).
  // More importantly: we never opt-in to CC on our side (no <track> child,
  // cc_load_policy=0 default).
  const cueTime = playbackTime - (startOffset || 0)
  const activeCue = cues?.find((c) => cueTime >= c.start && cueTime <= c.end)

  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-black",
        height == null && "h-full",
        className,
      )}
      style={height != null ? { height } : undefined}
    >
      <ReactPlayer
        ref={playerRef}
        // Force full re-mount when src changes so the player re-initializes
        // cleanly (especially important when switching between YouTube and
        // direct-file sources which use entirely different backends).
        key={src}
        src={src}
        controls
        width="100%"
        height="100%"
        style={{ maxHeight: "100%", maxWidth: "100%", objectFit: "contain" }}
      />
      {activeCue && activeCue.text && (
        <div
          className="pointer-events-none absolute bottom-16 left-1/2 z-10 -translate-x-1/2 px-4 text-center"
          style={{ maxWidth: "90%" }}
        >
          <span
            className="inline-block whitespace-pre-wrap rounded px-3 py-1.5 text-base font-medium leading-tight text-white"
            style={{
              backgroundColor: "rgba(0, 0, 0, 0.75)",
              textShadow: "1px 1px 2px rgba(0, 0, 0, 0.9)",
            }}
          >
            {activeCue.text}
          </span>
        </div>
      )}
    </div>
  )
})
