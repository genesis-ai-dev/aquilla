// Live waveform strip driven by a MediaStream. Draws a rolling amplitude
// trace of the last ~8 seconds by pushing RMS samples into a circular buffer
// and rendering on rAF. No audio is routed to output — the stream → analyser
// chain is tap-only.
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

import { WAV_SAMPLE_RATE } from "@/lib/audio/recording-limits"

interface Props {
  stream: MediaStream | null
  /** Height of the canvas in CSS pixels. Width fills the container. */
  height?: number
  /** Seconds of audio shown across the canvas width. */
  windowSec?: number
  className?: string
  /** "armed" draws the trace grey — the mic is hot but the take has not begun
   *  (the countdown). "live" is the recording red. A COLOUR, not a lifecycle:
   *  flipping it must never rebuild the audio graph, which is why it is read
   *  through a ref inside the draw loop and is deliberately NOT a dependency
   *  of the graph effect below. */
  tone?: "armed" | "live"
}

const TONE_STYLES = {
  armed: { stroke: "rgb(148,163,184)", fill: "rgba(148,163,184,0.08)" }, // slate-400
  live: { stroke: "rgb(239,68,68)", fill: "rgba(239,68,68,0.08)" }, // red-500
} as const

export function AudioWaveform({ stream, height = 48, windowSec = 8, className, tone = "live" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)
  const toneRef = useRef(tone)
  useEffect(() => {
    toneRef.current = tone
  }, [tone])

  useEffect(() => {
    if (!stream) {
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext("2d")
        ctx?.clearRect(0, 0, canvas.width, canvas.height)
      }
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
    analyser.smoothingTimeConstant = 0.3
    source.connect(analyser)

    const timeData = new Uint8Array(analyser.fftSize)
    // One RMS sample per frame; a rolling buffer sized to cover windowSec at
    // ~60fps. Using a Float32Array keeps the update O(1) via modular index.
    const bufferLen = Math.max(120, Math.floor(60 * windowSec))
    const amps = new Float32Array(bufferLen)
    let writeIdx = 0
    let frameCount = 0

    function resizeCanvas() {
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const cssWidth = canvas.clientWidth || 200
      canvas.width = Math.max(1, Math.floor(cssWidth * dpr))
      canvas.height = Math.max(1, Math.floor(height * dpr))
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resizeCanvas()
    const ro = new ResizeObserver(resizeCanvas)
    ro.observe(canvas)

    function draw() {
      analyser.getByteTimeDomainData(timeData)
      // RMS amplitude for this frame, normalized to [0, 1].
      let sumSq = 0
      for (let i = 0; i < timeData.length; i++) {
        const v = (timeData[i] - 128) / 128
        sumSq += v * v
      }
      const rms = Math.sqrt(sumSq / timeData.length)
      amps[writeIdx] = rms
      writeIdx = (writeIdx + 1) % bufferLen
      frameCount++

      if (!canvas || !ctx) return
      const w = canvas.clientWidth || 200
      const h = height
      const style = TONE_STYLES[toneRef.current]
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = style.fill
      ctx.fillRect(0, 0, w, h)
      const mid = h / 2
      ctx.strokeStyle = style.stroke
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x < w; x++) {
        // Map x → index in circular buffer. Older samples on the left, latest
        // on the right.
        const bufIdx = (writeIdx + bufferLen - Math.floor((w - x) / w * bufferLen)) % bufferLen
        const amp = amps[bufIdx] ?? 0
        const y = mid - amp * mid * 2.4 // scale up so quiet speech is visible
        const y2 = mid + amp * mid * 2.4
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
        ctx.lineTo(x, y2)
      }
      ctx.stroke()

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      ro.disconnect()
      try { source.disconnect() } catch {}
      try { analyser.disconnect() } catch {}
      audioCtx.close().catch(() => {})
      ctxRef.current = null
      void frameCount
    }
  }, [stream, height, windowSec])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height, display: "block" }}
      data-tone={tone}
      aria-hidden="true"
    />
  )
}
