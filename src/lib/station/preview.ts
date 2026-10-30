// How the Station plays (AQU-2327). The recording AS IT STANDS — deletes and
// inserts not yet saved, its volume and fades — is rendered to a short WAV and
// played by one <audio> element. That is deliberate:
//
//   - Everything is heard before anything is saved, at any level: volume above
//     0 dB is in the samples, so nothing has to raise an element past 1.
//   - The speed (0.5× to 2×) keeps the pitch: `preservesPitch` on an element.
//     A Web Audio buffer source changes pitch with its rate, which the working
//     build (board 40b) listed as its own limit.
//   - A blob URL is same-origin, so there is no CORS question, and no second
//     AudioContext (output-context.ts explains why the app keeps one).
//
// The element's clock IS the edited recording's clock, so a selection plays
// by seeking to its start and stopping at its end.

import { mixElement, mixerInput, type ClipLevel } from "@/lib/audio/mixer"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"

/** Can the Station play through the app's mixer here (an AudioContext)? Then
 *  the clip's volume and fades are the mixer's, with its peak guard; without
 *  one they are baked into the preview's samples. */
export function previewCanMix(): boolean {
  return mixerInput() != null
}

export interface PreviewCallbacks {
  /** Where it is, while it plays (recording seconds). */
  onTime?(sec: number): void
  /** It stopped by itself (reached `to`). */
  onEnded?(): void
}

export class StationPreview {
  private el: HTMLAudioElement | null = null
  private url: string | null = null
  private raf: number | null = null
  private stopAt = Infinity
  private loopFrom: number | null = null
  private level: ClipLevel | null = null
  private mixed = false
  private cb: PreviewCallbacks

  constructor(cb: PreviewCallbacks = {}) {
    this.cb = cb
  }

  private element(): HTMLAudioElement | null {
    if (this.el) return this.el
    if (typeof Audio === "undefined") return null
    const el = new Audio()
    el.preload = "auto"
    // Speed keeps the pitch (the default in every engine, said out loud).
    ;(el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true
    el.addEventListener("ended", () => this.finish())
    this.el = el
    return el
  }

  /** The samples to play from now on. Keeps the position if it was playing. */
  setSamples(samples: Float32Array, rate: number, opts: { mix?: boolean } = {}): void {
    const el = this.element()
    if (!el) return
    const wasAt = el.currentTime
    const wasPlaying = !el.paused
    const blob = encodeWavPcm16(samples, rate)
    const next = URL.createObjectURL(blob)
    const prev = this.url
    this.url = next
    el.src = next
    if (prev) URL.revokeObjectURL(prev)
    // Through the app's one mixer (AQU-2327): the clip's level and the peak guard.
    if (opts.mix) this.mixed = mixElement(el, "station", this.level)
    if (wasPlaying) {
      el.currentTime = wasAt
      void el.play().catch(() => this.finish())
    }
  }

  get playing(): boolean {
    return Boolean(this.el && !this.el.paused)
  }

  get time(): number {
    return this.el?.currentTime ?? 0
  }

  /** Play from `from` to `to` (recording seconds) at `rate`. With `loop`, it
   *  starts again at `from` each time it reaches `to`. */
  play(from: number, to: number, rate: number, loop = false): void {
    const el = this.element()
    if (!el || !this.url) return
    el.playbackRate = rate
    this.stopAt = to
    this.loopFrom = loop ? from : null
    const start = () => {
      el.currentTime = from
      void el.play().then(() => this.tick()).catch(() => this.finish())
    }
    if (el.readyState >= 1) start()
    else el.addEventListener("loadedmetadata", start, { once: true })
  }

  /** The clip's volume and fades, applied by the mixer (see `previewCanMix`). */
  setLevel(level: ClipLevel | null): void {
    this.level = level
    if (this.mixed && this.el) mixElement(this.el, "station", level)
  }

  setRate(rate: number): void {
    if (this.el) this.el.playbackRate = rate
  }

  setLoop(from: number | null): void {
    this.loopFrom = from
  }

  pause(): void {
    if (this.raf != null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.el?.pause()
  }

  private tick = (): void => {
    const el = this.el
    if (!el || el.paused) return
    if (el.currentTime >= this.stopAt - 0.005) {
      if (this.loopFrom != null) {
        el.currentTime = this.loopFrom
      } else {
        this.finish()
        return
      }
    }
    this.cb.onTime?.(el.currentTime)
    this.raf = requestAnimationFrame(this.tick)
  }

  private finish(): void {
    this.pause()
    this.cb.onEnded?.()
  }

  dispose(): void {
    this.pause()
    if (this.el) this.el.removeAttribute("src")
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
    this.el = null
  }
}
