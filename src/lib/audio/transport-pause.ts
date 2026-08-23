// Stop everything that can be playing, across BOTH transports. (AQU-646)
//
// This is the first thing in the app that does that, and it lives in its own
// module rather than in play-queue because play-queue deliberately does NOT
// reach the video — that boundary is the whole justification for
// MediaVideoPane's `suspended` prop existing, and teaching the queue to cross
// it would invalidate the reasoning behind a shipped prop.

import { pauseQueue } from "./play-queue"
import { getActiveAudio } from "./audio-coordinator"
import { getVideoController } from "@/lib/timeline/video-controller"

/**
 * Silence the queue, the single-cell clip, and the film.
 *
 * TWO THINGS THAT LOOK LIKE GAPS AND ARE NOT:
 *
 * 1. `getVideoController()` is null whenever the picture is SLAVED to the queue
 *    — the pane only registers a controller in the standalone arrangement. That
 *    is not a hole: a slaved film is stopped by `pauseQueue()` above, through
 *    the pane's own sync effect, which follows the queue's playing state.
 *
 * 2. Nothing here touches `setExternalDubsPlaying`. That flag is a DERIVED
 *    write, owned by the workspace effect that follows the video element's own
 *    play/pause events. Setting it out of band risks wedging it false for the
 *    rest of the session — after which dub overlays never fire again — because
 *    the setter early-returns when the value is unchanged. Pause the element;
 *    the overlays follow it.
 *
 * Every call is idempotent and a no-op when idle, so this is safe to fire from
 * an event handler that cannot know what, if anything, is playing.
 */
export function pauseAllTransports(): void {
  pauseQueue()
  getActiveAudio()?.pause()
  getVideoController()?.pause()
}
