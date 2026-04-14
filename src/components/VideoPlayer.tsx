import { forwardRef, useEffect, useImperativeHandle, useRef } from "react"
import { cn } from "@/lib/utils"

export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void
  getCurrentTime: () => number
  play: () => Promise<void>
  pause: () => void
}

interface VideoPlayerProps {
  src: string
  subtitleUrl?: string
  onTimeUpdate?: (seconds: number) => void
  onDurationChange?: (seconds: number) => void
  height: number
  className?: string
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(function VideoPlayer(
  { src, subtitleUrl, onTimeUpdate, onDurationChange, height, className },
  ref
) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      if (videoRef.current) {
        videoRef.current.currentTime = seconds
      }
    },
    getCurrentTime() {
      return videoRef.current?.currentTime ?? 0
    },
    async play() {
      await videoRef.current?.play()
    },
    pause() {
      videoRef.current?.pause()
    },
  }), [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    function onTime() { onTimeUpdate?.(v!.currentTime) }
    function onDur() { onDurationChange?.(v!.duration) }
    v.addEventListener("timeupdate", onTime)
    v.addEventListener("durationchange", onDur)
    return () => {
      v.removeEventListener("timeupdate", onTime)
      v.removeEventListener("durationchange", onDur)
    }
  }, [onTimeUpdate, onDurationChange])

  // Force the track to show. Assign mode="showing" after the track is loaded.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !subtitleUrl) return
    // Wait one tick for the <track> to attach to textTracks
    const id = setTimeout(() => {
      for (let i = 0; i < v.textTracks.length; i++) {
        v.textTracks[i].mode = "showing"
      }
    }, 100)
    return () => clearTimeout(id)
  }, [subtitleUrl])

  return (
    <div className={cn("flex items-center justify-center bg-black", className)} style={{ height }}>
      <video
        ref={videoRef}
        controls
        className="max-h-full max-w-full"
        // Bust React reuse when subtitleUrl changes — force re-render of tracks
        key={subtitleUrl || "no-subs"}
      >
        <source src={src} />
        {subtitleUrl && (
          <track kind="subtitles" src={subtitleUrl} default label="Translation" />
        )}
      </video>
    </div>
  )
})
