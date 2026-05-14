// MediaRecorder state machine for per-cell audio capture.
// States: idle → requesting → recording → stopped | error
// Caller retrieves the blob from stopped state and is responsible for upload
// and cleanup (reset() drops it).

import { useCallback, useEffect, useRef, useState } from "react"

export type RecorderState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "stopped"; blob: Blob; mimeType: string; ext: string; durationSec: number }
  | { kind: "error"; message: string }

export interface UseAudioRecorder {
  state: RecorderState
  elapsedMs: number
  /** Live MediaStream, populated while state.kind === 'recording'. Consumers
   *  (like a live AnalyserNode waveform) can observe state and read this. */
  stream: MediaStream | null
  start: () => Promise<void>
  stop: () => void
  reset: () => void
}

// Preference order matches desktop (webm/opus 256k). Browsers that lack opus
// fall back to webm, then the MediaRecorder default.
function pickMimeType(): { mimeType: string; ext: string } {
  const candidates: Array<{ mimeType: string; ext: string }> = [
    { mimeType: "audio/webm;codecs=opus", ext: "webm" },
    { mimeType: "audio/webm", ext: "webm" },
    { mimeType: "audio/ogg;codecs=opus", ext: "ogg" },
    { mimeType: "audio/mp4", ext: "m4a" },
  ]
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c.mimeType)) {
      return c
    }
  }
  return { mimeType: "", ext: "webm" }
}

export function useAudioRecorder(): UseAudioRecorder {
  const [state, setState] = useState<RecorderState>({ kind: "idle" })
  const [elapsedMs, setElapsedMs] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const elapsedMsRef = useRef(0)
  useEffect(() => { elapsedMsRef.current = elapsedMs }, [elapsedMs])

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    if (recorderRef.current) {
      try { if (recorderRef.current.state !== "inactive") recorderRef.current.stop() } catch {}
      recorderRef.current = null
    }
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop()
      streamRef.current = null
    }
    setStream(null)
    chunksRef.current = []
  }, [])

  useEffect(() => () => cleanup(), [cleanup])

  const start = useCallback(async () => {
    if (state.kind === "requesting" || state.kind === "recording") return
    setState({ kind: "requesting" })
    setElapsedMs(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      streamRef.current = stream
      setStream(stream)
      const pick = pickMimeType()
      const rec = new MediaRecorder(stream, pick.mimeType
        ? { mimeType: pick.mimeType, audioBitsPerSecond: 256_000 }
        : { audioBitsPerSecond: 256_000 })
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onerror = (e) => {
        const err = (e as unknown as { error?: Error }).error
        cleanup()
        setState({ kind: "error", message: err?.message ?? "Recorder error" })
      }
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: pick.mimeType || "audio/webm" })
        const durationSec = elapsedMsRef.current / 1000
        // Release the mic promptly — we've already captured bytes.
        if (streamRef.current) {
          for (const t of streamRef.current.getTracks()) t.stop()
          streamRef.current = null
        }
        setStream(null)
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
        recorderRef.current = null
        setState({ kind: "stopped", blob, mimeType: pick.mimeType || "audio/webm", ext: pick.ext, durationSec })
      }
      recorderRef.current = rec
      const startedAt = Date.now()
      rec.start(250)
      setState({ kind: "recording", startedAt })
      tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 100)
    } catch (e) {
      cleanup()
      const message = e instanceof Error ? e.message : String(e)
      setState({ kind: "error", message })
    }
  }, [cleanup, state.kind])

  const stop = useCallback(() => {
    const rec = recorderRef.current
    if (!rec || rec.state === "inactive") return
    try { rec.stop() } catch {}
  }, [])

  const reset = useCallback(() => {
    cleanup()
    setElapsedMs(0)
    setState({ kind: "idle" })
  }, [cleanup])

  return { state, elapsedMs, stream, start, stop, reset }
}
