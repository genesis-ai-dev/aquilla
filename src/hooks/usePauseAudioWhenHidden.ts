// Sam, 2026-10-19 (V1 walk, "next takes ready"): leaving the Aquilla tab while
// the timeline played stopped the sound but not the playhead, and coming back
// never picked the sound up again. A hidden tab's timers are slowed or stopped,
// and the timeline fires every take from timers, so it cannot keep playing
// correctly there. So leaving the tab pauses whatever is playing, and coming
// back plays it on from the same place (Sam, 2026-10-20: it should carry on by
// itself, as if it never stopped) — only what this paused, never something the
// person had paused themselves.
import { useEffect } from "react"
import { getActiveAudio } from "@/lib/audio/audio-coordinator"
import { getQueueState, pauseQueue, resumeQueue } from "@/lib/audio/play-queue"
import { getVideoController } from "@/lib/timeline/video-controller"

/** What leaving the tab paused, to play again on return. */
let resumeOnReturn: (() => void) | null = null

/** Leaving: pause every player that is sounding, and remember which.
 *  Returning: play those again. Each is a no-op for a player not sounding. */
export function pauseAudioWhenHidden(): void {
  if (document.visibilityState !== "hidden") {
    const resume = resumeOnReturn
    resumeOnReturn = null
    resume?.()
    return
  }
  const resumes: Array<() => void> = []
  // The picture or the timeline's own clock (the virtual clock registers as
  // the video controller when there is no picture).
  const video = getVideoController()
  if (video && !video.isPaused()) {
    video.pause()
    resumes.push(() => { if (video.isPaused()) video.play() })
  }
  const queue = getQueueState().kind
  if (queue === "playing" || queue === "loading") {
    pauseQueue()
    resumes.push(() => { if (getQueueState().kind === "paused") void resumeQueue() })
  }
  // Anything else that holds the floor: a card's take, a preview, a take row.
  // Asked after the others, so a player paused above is not paused twice.
  const active = getActiveAudio()
  if (active?.isPlaying()) {
    active.pause()
    resumes.push(() => { if (!active.isPlaying()) void active.play() })
  }
  resumeOnReturn = resumes.length > 0 ? () => { for (const resume of resumes) resume() } : null
}

export function usePauseAudioWhenHidden(): void {
  useEffect(() => {
    document.addEventListener("visibilitychange", pauseAudioWhenHidden)
    return () => {
      document.removeEventListener("visibilitychange", pauseAudioWhenHidden)
      resumeOnReturn = null
    }
  }, [])
}
