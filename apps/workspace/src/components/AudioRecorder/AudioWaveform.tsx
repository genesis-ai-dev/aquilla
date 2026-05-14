// Live waveform strip driven by a MediaStream. Draws a rolling amplitude
// trace of the last ~8 seconds by pushing RMS samples into a circular buffer
// and rendering on rAF. No audio is routed to output — the stream → analyser
// chain is tap-only.

import { useEffect, useRef } from "react"

interface Props {
  stream: MediaStream | null
  /** Height of the canvas in CSS pixels. Width fills the container. */
  height?: number
  /** Seconds of audio shown across the canvas width. */
  windowSec?: number
  className?: string
}

export function AudioWaveform({ stream, height = 48, windowSec = 8, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)

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
    const audioCtx = new AudioCtx()
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
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = "rgba(239,68,68,0.08)" // red-500/8 subtle background
      ctx.fillRect(0, 0, w, h)
      const mid = h / 2
      ctx.strokeStyle = "rgb(239,68,68)"
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
      aria-hidden="true"
    />
  )
}
