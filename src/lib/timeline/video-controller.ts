// Commanding the linked picture from outside the pane. (AQU-646 round 5)
//
// `video-clock.ts` is the picture talking; this is the picture listening. The
// bottom playback bar has to DRIVE the transport it reports — play, pause,
// scrub, rate, volume — and until now the only channel to the video element was
// a play/pause nonce and a seek stamp threaded as props through the workspace.
//
// A registered controller rather than more props, following the
// `ActiveAudioController` idiom in `lib/audio/audio-coordinator.ts`: the pane
// owns the element and registers a small delegating object that reads it live,
// so a caller never holds a render-time snapshot of a media element's state.
//
// The play/pause NONCE stays for Space. It is a toggle against the element's
// own `paused`, which cannot drift out of step with the native controls the way
// a desired-state command can — see MediaVideoPane's togglePlay effect.

import { useSyncExternalStore } from "react"

export interface VideoController {
  play: () => void
  pause: () => void
  /** True while the element is actually paused. Read live. */
  isPaused: () => boolean
  seek: (sec: number) => void
  setRate: (rate: number) => void
  setVolume: (volume: number) => void
}

let current: VideoController | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The pane registers on mount. One picture is on screen at a time. */
export function setVideoController(controller: VideoController): void {
  if (current === controller) return
  current = controller
  notify()
}

/** Guarded so a late unmount cannot clear a newer pane's registration. */
export function clearVideoControllerIf(controller: VideoController): void {
  if (current !== controller) return
  current = null
  notify()
}

export function getVideoController(): VideoController | null {
  return current
}

export function useVideoController(): VideoController | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

export function resetVideoControllerForTests(): void {
  current = null
  notify()
}
