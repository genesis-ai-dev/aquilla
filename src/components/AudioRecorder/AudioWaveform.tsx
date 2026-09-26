// The take being recorded, drawn as it grows. Driven by a MediaStream: one
// PEAK per animation frame, read off an analyser that is tap-only (nothing is
// routed to output).
//
// AQU-1210 (Sam, 2026-09-25): this used to be a trace scrolling past. It is
// now the same rectangle every saved take is drawn as — the timeline chip's
// body, outline and 40% ink, in grey — filling from the left as you speak,
// with a red line at the growing edge. During the countdown the mic is hot but
// no take has begun, so the rectangle is an empty body. The span matches the
// target bar below it, and widens once the take runs past it. Its shape is
// built by the same two rules as the saved waveform (see live-take-shape), so
// Stop hands over to a preview that looks like what you were watching.
//
// THIS COMPONENT'S MOUNT TIMING IS PART OF THE RECORDER'S CORRECTNESS
// (2026-08-14). Its AudioContext attaches to the same microphone the capture
// graph is recording, and opening a context against a live input can make the
// browser/OS reconfigure the device — degraded input, a hard gap, then a
// fade-in, all measured at ~1.4s in one of Sam's takes, eating his first word.
// Two rules follow: the modal mounts this DURING the countdown (so any
// renegotiation lands in discarded pre-mark audio, not the take), and the
// context is pinned to the capture rate below so there is no rate disagreement
// to renegotiate. Do not move this back inside the recording-only branch.

import { useEffect, useRef } from "react"
import type { CSSProperties } from "react"

import { cn } from "@/lib/utils"
import { WAV_SAMPLE_RATE } from "@/lib/audio/recording-limits"
import { VERTICAL_INSET_PX } from "@/lib/audio/waveform-shape"
import { columnPeaks, LIVE_PEAK_FLOOR, liveSpanSec } from "@/lib/audio/live-take-shape"
import { NEUTRAL_TRACK_VARS, trackChipClass, trackChipPlayingClass } from "@/lib/timeline/track-colors"

interface Props {
  stream: MediaStream | null
  /** Outer height in CSS pixels, border included. Width fills the container. */
  height?: number
  /** The line's target length. The rectangle spans it plus `headroomSec` —
   *  DurationBar's own axis, so the two move together. */
  targetSec?: number | null
  headroomSec?: number
  /** The span when there is no target. */
  windowSec?: number
  className?: string
  /** "armed": the mic is hot but the take has not begun (the countdown) — an
   *  empty body. "live": the take is being recorded and the shape grows. A
   *  STATE OF THE DRAWING, not a lifecycle: flipping it must never rebuild the
   *  audio graph, which is why it (like the target) is read through a ref
   *  inside the draw loop and is deliberately NOT a dependency of the graph
   *  effect below. */
  tone?: "armed" | "live"
}

export function AudioWaveform({
  stream,
  height = 56,
  targetSec = null,
  headroomSec = 1.5,
  windowSec = 8,
  className,
  tone = "live",
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const toneRef = useRef(tone)
  const spanRef = useRef({ targetSec, headroomSec, windowSec })
  useEffect(() => {
    toneRef.current = tone
    spanRef.current = { targetSec, headroomSec, windowSec }
  }, [tone, targetSec, headroomSec, windowSec])

  useEffect(() => {
    const showGrowth = (frac: number | null) => {
      boxRef.current?.style.setProperty("--tl-play-x", `${(frac ?? 0) * 100}%`)
      const cursor = cursorRef.current
      if (cursor) {
        cursor.style.display = frac == null ? "none" : "block"
        cursor.style.left = `${(frac ?? 0) * 100}%`
      }
    }

    if (!stream) {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext("2d")
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
      }
      showGrowth(null)
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    // The CAPTURE rate, never the default: a default-rate context (often the
    // device's 44.1k) coexisting with the 48k capture context on one mic is
    // exactly the rate disagreement that forces a device restart mid-take.
    let audioCtx: AudioContext
    try {
      audioCtx = new AudioCtx({ sampleRate: WAV_SAMPLE_RATE })
    } catch {
      audioCtx = new AudioCtx()
    }
    ctxRef.current = audioCtx
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)

    const timeData = new Float32Array(analyser.fftSize)
    // The take so far: one (time, peak) per frame, grown by doubling. Timed
    // rather than counted, so a throttled frame rate never stretches the shape.
    let times = new Float32Array(1024)
    let peaks = new Float32Array(1024)
    let n = 0
    let loudest = 0
    let liveSince: number | null = null
    let cols = new Float32Array(0)
    let ink = ""

    function resizeCanvas() {
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const cssWidth = canvas.clientWidth || 200
      const cssHeight = canvas.clientHeight || Math.max(1, height - 2)
      canvas.width = Math.max(1, Math.floor(cssWidth * dpr))
      canvas.height = Math.max(1, Math.floor(cssHeight * dpr))
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      // The chip's ink is its text colour; read it here, not every frame.
      ink = getComputedStyle(canvas).color || "currentColor"
    }

    resizeCanvas()
    const ro = new ResizeObserver(resizeCanvas)
    ro.observe(canvas)

    function draw() {
      rafRef.current = requestAnimationFrame(draw)
      if (!canvas || !ctx) return
      const w = canvas.clientWidth || 200
      const h = canvas.clientHeight || Math.max(1, height - 2)

      if (toneRef.current !== "live") {
        // Counting in: an empty body. A take that ended is let go here, so the
        // next one starts from nothing.
        if (liveSince != null || n > 0) {
          liveSince = null
          n = 0
          loudest = 0
        }
        ctx.clearRect(0, 0, w, h)
        showGrowth(null)
        return
      }

      const now = performance.now()
      if (liveSince == null) {
        liveSince = now
        ink = getComputedStyle(canvas).color || ink
      }
      analyser.getFloatTimeDomainData(timeData)
      let peak = 0
      for (let i = 0; i < timeData.length; i++) {
        const v = Math.abs(timeData[i])
        if (v > peak) peak = v
      }
      if (n === times.length) {
        const t2 = new Float32Array(n * 2); t2.set(times); times = t2
        const p2 = new Float32Array(n * 2); p2.set(peaks); peaks = p2
      }
      const elapsedSec = (now - liveSince) / 1000
      times[n] = elapsedSec
      peaks[n] = peak
      n++
      if (peak > loudest) loudest = peak

      const { targetSec: tgt, headroomSec: head, windowSec: fallback } = spanRef.current
      const span = liveSpanSec(elapsedSec, tgt, head, fallback)
      const frac = Math.min(1, elapsedSec / span)
      showGrowth(frac)

      // The ink: the envelope of the part recorded so far, drawn the way the
      // saved waveform draws it (bin centres, mirrored about the midline, a
      // half-pixel floor so a pause still reads as a pause).
      const count = Math.max(1, Math.ceil(frac * w))
      if (cols.length !== Math.ceil(w)) cols = new Float32Array(Math.ceil(w))
      columnPeaks(times, peaks, n, span, Math.ceil(w), cols)
      const scale = 1 / Math.max(loudest, LIVE_PEAK_FLOOR)
      const usable = Math.max(1, h - VERTICAL_INSET_PX)
      const mid = h / 2
      ctx.clearRect(0, 0, w, h)
      ctx.globalAlpha = 0.4
      ctx.fillStyle = ink
      ctx.beginPath()
      ctx.moveTo(0, mid)
      for (let c = 0; c < count; c++) {
        const y = Math.max(0.5, (Math.min(1, cols[c] * scale) * usable) / 2)
        ctx.lineTo(c + 0.5, mid - y)
      }
      ctx.lineTo(count, mid)
      for (let c = count - 1; c >= 0; c--) {
        const y = Math.max(0.5, (Math.min(1, cols[c] * scale) * usable) / 2)
        ctx.lineTo(c + 0.5, mid + y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.globalAlpha = 1
    }

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      ro.disconnect()
      try { source.disconnect() } catch {}
      try { analyser.disconnect() } catch {}
      audioCtx.close().catch(() => {})
      ctxRef.current = null
    }
  }, [stream, height])

  return (
    <div
      ref={boxRef}
      data-testid="rec-live-waveform"
      className={cn(
        // The chip's body in grey, with its playing split doing the growing:
        // the recorded part at the body's own strength, the rest not yet.
        "relative overflow-hidden rounded-[6px] border",
        trackChipClass("take"),
        trackChipPlayingClass("take"),
        className,
      )}
      style={{ ...NEUTRAL_TRACK_VARS, height, "--tl-play-x": "0%" } as CSSProperties}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 block h-full w-full"
        data-tone={tone}
        aria-hidden="true"
      />
      <div
        ref={cursorRef}
        aria-hidden
        data-testid="rec-live-cursor"
        className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-red-500"
        style={{ display: "none", left: 0 }}
      />
    </div>
  )
}
