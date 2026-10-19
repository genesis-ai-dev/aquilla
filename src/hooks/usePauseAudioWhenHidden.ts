// Sam, 2026-10-19 (V1 walk, "next takes ready"): leaving the Aquilla tab while
// the timeline played stopped the sound but not the playhead, and coming back
// never picked the sound up again. A hidden tab's timers are slowed or stopped,
// and the timeline fires every take from timers, so it cannot keep playing
// correctly there. Leaving the tab pauses whatever is playing instead; Play
// carries on from the same place on return.
import { useEffect } from "react"
import { getActiveAudio } from "@/lib/audio/audio-coordinator"
import { getQueueState, pauseQueue } from "@/lib/audio/play-queue"
import { getVideoController } from "@/lib/timeline/video-controller"

/** Pause every player that may be sounding — each is a no-op when it isn't. */
export function pauseAudioWhenHidden(): void {
  if (document.visibilityState !== "hidden") return
  // The picture or the timeline's own clock (the virtual clock registers as
  // the video controller when there is no picture).
  const video = getVideoController()
  if (video && !video.isPaused()) video.pause()
  const queue = getQueueState().kind
  if (queue === "playing" || queue === "loading") pauseQueue()
  // Anything else that holds the floor: a card's take, a preview, a take row.
  const active = getActiveAudio()
  if (active?.isPlaying()) active.pause()
}

export function usePauseAudioWhenHidden(): void {
  useEffect(() => {
    document.addEventListener("visibilitychange", pauseAudioWhenHidden)
    return () => document.removeEventListener("visibilitychange", pauseAudioWhenHidden)
  }, [])
}
