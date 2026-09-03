// Stop playback when the audio output device changes under it. (AQU-646)
//
// Sam's call, chosen over letting the playhead quietly re-sync mid-flight: a
// device switch is disruptive anyway — there is a gap, a glitch, and a sudden
// change in how far ahead the playhead is — so the honest response is to stop
// and let the person start again, with a line saying why.
//
// THE HARD PART IS NOT THE PAUSE, IT IS KNOWING WHEN. `devicechange` fires for
// INPUT devices too: plug in a USB microphone or a webcam and it fires, and
// pausing someone's review session because they plugged in a webcam would be a
// worse bug than the one this fixes. So the event is only a prompt to go and
// look; the decision is made by re-reading the OUTPUT latency, which is the
// thing we actually care about and the thing that actually changed.
//
// WHEN IT CANNOT TELL, IT DOES NOTHING. A missed pause costs a stale
// compensation for a few tens of milliseconds. A false pause costs someone's
// place in a take they were listening to. Those are not symmetric.

import { getOutputLatencySec, refreshOutputLatency } from "./output-latency"
import { micIsHeld } from "./mic-hold"
import { pauseAllTransports } from "./transport-pause"

/** One physical change fires several events; coalesce them. */
const DEBOUNCE_MS = 250

/** Chrome tears down and rebuilds the output stream on a default-device change,
 *  so the new latency is not readable in the same task. Back off and re-ask. */
const PROBE_DELAYS_MS = [150, 300, 600, 1200]

/** Above wired-to-wired jitter (~0.015-0.025s), far below the Bluetooth delta
 *  (~0.15s). */
const MATERIAL_CHANGE_SEC = 0.02

export interface OutputDeviceWatchOptions {
  /** Only pause something that is actually playing. */
  isPlaying: () => boolean
  /** Told once, when a change is confirmed. */
  onPaused: () => void
}

/**
 * Start watching. Returns a stop function.
 *
 * The listener is attached HERE and never at module import: happy-dom
 * implements neither `AudioContext` nor `navigator.mediaDevices`, so a
 * module-scope listener would throw the moment this file entered any
 * component's import graph.
 */
export function startOutputDeviceWatch(opts: OutputDeviceWatchOptions): () => void {
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined
  if (!media?.addEventListener) return () => {}

  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let stopped = false

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function evaluate(): Promise<void> {
    const gen = ++generation
    // Nothing is sounding: just refresh what we know for the next play.
    if (!opts.isPlaying()) {
      refreshOutputLatency()
      return
    }
    const before = getOutputLatencySec()

    for (const delay of PROBE_DELAYS_MS) {
      await sleep(delay)
      if (stopped || gen !== generation) return
      // Re-probe without publishing yet: we need the delta, and publishing a
      // half-settled value would shift the playhead before we decide to stop.
      if (!refreshOutputLatency()) continue
      const now = getOutputLatencySec()
      if (Math.abs(now - before) > MATERIAL_CHANGE_SEC) {
        pauseAllTransports()
        opts.onPaused()
        return
      }
    }
    // Inconclusive. Deliberately silent — see the header.
  }

  const onDeviceChange = () => {
    // Never reach for the device while a take is possible.
    if (micIsHeld()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void evaluate(), DEBOUNCE_MS)
  }

  media.addEventListener("devicechange", onDeviceChange)
  return () => {
    stopped = true
    generation++
    if (timer) clearTimeout(timer)
    media.removeEventListener("devicechange", onDeviceChange)
  }
}
