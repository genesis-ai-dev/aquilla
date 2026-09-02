// The app's ONE long-lived output AudioContext. (AQU-646)
//
// This is not a new context. It is the countdown's beep context, lifted out of
// useCountdown so the output-latency probe can share it instead of opening a
// second one. That distinction matters more than it looks:
//
// OPENING AND CLOSING AUDIO CONTEXTS IS WHAT MAKES THE BROWSER/OS RECONFIGURE
// THE SHARED AUDIO DEVICE, and on combined input/output hardware (a headset)
// that churn reaches the MICROPHONE — measured in a real take as a degraded
// head, a hard gap, and a fade-in that ate the operator's first word. Pinned to
// the capture rate so this context can never be the rate disagreement that
// forces the restart. Both rules are inherited verbatim from the two places
// that learned them the hard way (useCountdown.ts, AudioWaveform.tsx).
//
// AND BROWSERS CAP A PAGE AT ROUGHLY SIX CONTEXTS. Count the realistic peak
// with the recorder open on a media file: this one + AudioWaveform's meter +
// the armed pcm-capture graph + up to two peaks decodes + a duration probe at
// take-attach. That is already five or six. A seventh permanent context, opened
// merely to read a number, is genuinely close to the edge — which is why the
// latency probe borrows this one rather than minting its own.
//
// NO `latencyHint`. The default ("interactive") is deliberate. "playback"
// enlarges the callback buffer for power efficiency, which would inflate this
// context's own reported latency to ~150ms — and since we use that reading to
// estimate the DEVICE's delay, we want our own contribution as small as
// possible, not as large as possible. It would also put every countdown beep
// audibly behind its own tick.

import { WAV_SAMPLE_RATE } from "./recording-limits"

let ctx: AudioContext | null = null

function ctor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  return w.AudioContext ?? w.webkitAudioContext ?? null
}

/**
 * The shared context, creating it on first use.
 *
 * Null when the platform has no AudioContext at all — happy-dom does not
 * implement one, so this is the ordinary answer throughout the unit suite and
 * every caller must handle it.
 *
 * CREATING one is the only operation here that can disturb the audio device;
 * reading a property off a live one cannot. Callers that must not touch the
 * device (the latency probe, while a take is in flight) should check their own
 * interlock before calling this, and use `peekOutputContext` otherwise.
 */
export function getOutputContext(): AudioContext | null {
  if (ctx && ctx.state !== "closed") return ctx
  const Ctor = ctor()
  if (!Ctor) return null
  try {
    ctx = new Ctor({ sampleRate: WAV_SAMPLE_RATE })
  } catch {
    try {
      ctx = new Ctor()
    } catch {
      return null
    }
  }
  return ctx
}

/** The context if one already exists — never creates. For readers that must not
 *  be the thing that first opens the output device. */
export function peekOutputContext(): AudioContext | null {
  return ctx && ctx.state !== "closed" ? ctx : null
}

/** The singleton outlives any one test's AudioContext fake — a test that counts
 *  beeps (or reads a latency) must drop it first, or it works against an
 *  earlier test's fake. */
export function resetOutputContextForTests(): void {
  ctx = null
}
