// State machine for per-cell audio capture.
// States: idle → requesting → recording → stopped | error
// Caller retrieves the blob from stopped state and is responsible for upload
// and cleanup (reset() drops it).
//
// TWO capture paths behind one state machine, chosen at start():
//   - WAV, the default since the 2026-08-12 client meeting, captured through an
//     AudioWorklet (MediaRecorder cannot produce WAV in any browser).
//   - webm/opus through MediaRecorder — the opt-out, and the fallback whenever
//     anything about the WAV path fails.
//
// THE PUBLIC SHAPE MUST NOT CHANGE. Every consumer of this hook is tested by
// module-mocking it and returning a PARTIAL object, so anything new that a
// consumer *requires* from here reds those suites. The options argument is
// additive for the same reason: mocks that ignore their arguments keep working.

import { useCallback, useEffect, useRef, useState } from "react"

import {
  isPcmCaptureSupported,
  preloadPcmCaptureModule,
  startPcmCapture,
  type PcmCaptureHandle,
} from "@/lib/audio/pcm-capture"
import { recordingLimitsFor } from "@/lib/audio/recording-limits"
import { encodeWavPcm16Chunks } from "@/lib/audio/wav-encode"
import { getRecordingFormatPref, type RecordingFormat } from "@/lib/store/recording-format-pref"

// The webm ceilings, still exported because consumers (and this hook's test)
// import them directly. Read out of the shared limit table rather than restated
// here so the compressed path cannot drift from the table the WAV path uses.
const WEBM_LIMITS = recordingLimitsFor("webm")
export const RECORDING_WARN_MS = WEBM_LIMITS.warnMs  // 25 minutes
export const RECORDING_HARD_STOP_MS = WEBM_LIMITS.hardStopMs  // 30 minutes

export type RecorderState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; startedAt: number }
  | { kind: "stopped"; blob: Blob; mimeType: string; ext: string; durationSec: number }
  | { kind: "error"; message: string }

export interface UseAudioRecorderOptions {
  /** Pin the capture format instead of following the device preference.
   *  Undefined (the normal case) means "whatever the pref says at start()". */
  format?: RecordingFormat
  /** A tighter byte budget than the upload cap, turned into a shorter hard
   *  stop. The voice-clone reference has one; checking it once the take is
   *  already over is a late failure the operator pays for. */
  maxBytes?: number
}

export interface UseAudioRecorder {
  state: RecorderState
  elapsedMs: number
  /** True once the elapsed time passes the warning threshold for the format
   *  the current take is being captured in (12 min WAV, 25 min webm, less if
   *  the caller passed a maxBytes). */
  isNearLimit: boolean
  /** Live MediaStream, populated while state.kind === 'recording'. Consumers
   *  (like a live AnalyserNode waveform) can observe state and read this. */
  stream: MediaStream | null
  /** Open the mic without starting recording. Call during a pre-recording
   *  countdown so macOS/Chrome AGC has time to stabilise before bytes are
   *  captured — prevents the "quiet first few seconds then suddenly loud"
   *  ramp-up artefact. Safe to call more than once; idempotent. */
  prewarm: () => Promise<void>
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

export function useAudioRecorder(opts?: UseAudioRecorderOptions): UseAudioRecorder {
  const [state, setState] = useState<RecorderState>({ kind: "idle" })
  const [elapsedMs, setElapsedMs] = useState(0)
  const [stream, setStream] = useState<MediaStream | null>(null)
  // Pinned when a take starts, because which threshold applies depends on the
  // format that take is actually being captured in. Before the first take
  // elapsedMs is 0, so the initial value is never observable.
  const [warnMs, setWarnMs] = useState(RECORDING_WARN_MS)
  const isNearLimit = elapsedMs >= warnMs
  // Read off `opts` as primitives rather than depending on the object: callers
  // pass an inline literal, so depending on its identity would hand every
  // consumer a new start()/prewarm() on every render.
  const formatOpt = opts?.format
  const maxBytesOpt = opts?.maxBytes
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const pcmRef = useRef<PcmCaptureHandle | null>(null)
  const pcmFinishRef = useRef<Promise<void> | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const elapsedMsRef = useRef(0)
  useEffect(() => { elapsedMsRef.current = elapsedMs }, [elapsedMs])

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    if (recorderRef.current) {
      try { if (recorderRef.current.state !== "inactive") recorderRef.current.stop() } catch {}
      recorderRef.current = null
    }
    if (pcmRef.current) {
      // dispose() is flush-less and closes the AudioContext. Browsers cap a
      // page at roughly six contexts and the live waveform already builds one
      // per take, so every exit path has to come through here.
      try { pcmRef.current.dispose() } catch {}
      pcmRef.current = null
    }
    pcmFinishRef.current = null
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop()
      streamRef.current = null
    }
    setStream(null)
    chunksRef.current = []
  }, [])

  /**
   * Finish a WAV take: flush the worklet, encode, publish `stopped`.
   *
   * Idempotent because two callers race for it — the operator's Stop button and
   * the frame-count limit — and running it twice would encode the take twice
   * and stop the mic tracks out from under the first flush.
   */
  const finishWavTake = useCallback(() => {
    const handle = pcmRef.current
    if (!handle || pcmFinishRef.current) return
    pcmFinishRef.current = (async () => {
      try {
        const chunks = await handle.finish()
        // reset() or an unmount can land while the flush is in flight; the take
        // has been abandoned, so don't resurrect it as `stopped`.
        if (pcmRef.current !== handle) return
        // The context's REAL rate, never WAV_SAMPLE_RATE: Firefox may refuse
        // the rate we ask for, and a header that hardcodes 48000 in that case
        // makes every take play at the wrong pitch — silently, and beyond
        // repair once it has been uploaded.
        const blob = encodeWavPcm16Chunks(chunks, handle.sampleRate)
        // Sample-exact, unlike the webm branch's wall clock (which is all
        // Chrome leaves us, since it writes no duration header).
        const durationSec = handle.frames() / handle.sampleRate
        // Release the mic only now: the flush above had to complete first, or
        // the last ~85ms — the end of the final word — is lost on every take.
        if (streamRef.current) {
          for (const t of streamRef.current.getTracks()) t.stop()
          streamRef.current = null
        }
        setStream(null)
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
        pcmRef.current = null
        setState({ kind: "stopped", blob, mimeType: "audio/wav", ext: "wav", durationSec })
      } catch (e) {
        cleanup()
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) })
      }
    })()
  }, [cleanup])

  useEffect(() => () => cleanup(), [cleanup])

  const MIC_CONSTRAINTS = {
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  }

  const prewarm = useCallback(async () => {
    // Fetch the capture worklet while the countdown runs, so its round trip is
    // not charged to the operator's first word. Deliberately NOT awaited (the
    // mic prompt should go up immediately) and it never rejects. It must not
    // build the AudioContext either — a cancelled countdown would leak one.
    if ((formatOpt ?? getRecordingFormatPref()) === "wav") void preloadPcmCaptureModule()
    if (streamRef.current) return
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
      streamRef.current = s
      setStream(s)
    } catch {
      // Ignore — permission errors surface again when start() is called.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatOpt])

  const start = useCallback(async () => {
    if (state.kind === "requesting" || state.kind === "recording") return
    setState({ kind: "requesting" })
    setElapsedMs(0)
    // Read the preference PLAINLY, not reactively: this pins the format for
    // this take. Subscribing would re-render the recorder on every pref change
    // and, worse, invite a flip mid-take that the captured bytes cannot honour.
    const format = formatOpt ?? getRecordingFormatPref()
    const limits = recordingLimitsFor(format, { maxBytes: maxBytesOpt })
    setWarnMs(limits.warnMs)
    try {
      const stream = streamRef.current ?? await navigator.mediaDevices.getUserMedia({
        audio: MIC_CONSTRAINTS,
      })
      streamRef.current = stream
      setStream(stream)

      if (format === "wav" && isPcmCaptureSupported()) {
        try {
          const handle = await startPcmCapture({
            stream,
            // The hard stop is a FRAME COUNT, not the wall clock: frames are
            // immune to background-tab timer throttling, and they are the
            // number that actually decides whether the take clears the upload
            // cap. The interval below keeps ticking elapsedMs for the display
            // only.
            maxFrames: limits.maxFrames,
            onLimit: () => finishWavTake(),
          })
          pcmRef.current = handle
          pcmFinishRef.current = null
          const startedAt = Date.now()
          setState({ kind: "recording", startedAt })
          tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 100)
          return
        } catch {
          // ANY failure of the WAV path — no worklet, a context the browser
          // refused, a bundler chunk that 404s in production — falls all the
          // way through to the MediaRecorder branch below, untouched. A
          // compressed take is a take; a broken one is a performance the
          // operator has to give again.
          if (pcmRef.current) { try { pcmRef.current.dispose() } catch {} ; pcmRef.current = null }
        }
      }

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
      tickRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAt
        setElapsedMs(elapsed)
        // Still the wall clock here, because MediaRecorder never tells us how
        // many frames it has swallowed. limits.hardStopMs is the historic 30
        // minutes for a plain take and shorter only when the caller asked for
        // a tighter byte budget.
        if (elapsed >= limits.hardStopMs) {
          try { recorderRef.current?.stop() } catch {}
        }
      }, 100)
    } catch (e) {
      cleanup()
      const message = e instanceof Error ? e.message : String(e)
      setState({ kind: "error", message })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanup, finishWavTake, formatOpt, maxBytesOpt, state.kind])

  const stop = useCallback(() => {
    // A WAV take has no MediaRecorder to stop — flushing the worklet IS the
    // stop, and it is what publishes the blob.
    if (pcmRef.current) { finishWavTake(); return }
    const rec = recorderRef.current
    if (!rec || rec.state === "inactive") return
    try { rec.stop() } catch {}
  }, [finishWavTake])

  const reset = useCallback(() => {
    cleanup()
    setElapsedMs(0)
    setState({ kind: "idle" })
  }, [cleanup])

  return { state, elapsedMs, isNearLimit, stream, prewarm, start, stop, reset }
}
