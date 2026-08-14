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
// THE TAKE-SHIFT FIX (2026-08-14). Sample 0 of a saved take is anchored to the
// line's start on the timeline, so every millisecond between "the app told the
// operator to speak" and "the file actually began" lands in the take as dead
// air at the head — and Sam measured over a second of it (GO rendered a full
// second before onDone, then 25–160ms of AudioContext construction, then ~50ms
// of zero-filled quanta while the mic's frames were still in flight). The fix
// inverts the ordering: prewarm() — called at the TOP of the countdown — now
// builds the whole capture graph ARMED, running but emitting nothing, and
// start() collapses to mark(): a synchronous bookmark that makes sample 0 land
// within one render quantum of the instant the operator was cued. If the armed
// build failed, or the pref is webm, start() is exactly the old path.
//
// The other half: stop() used to seal the file immediately, but the audio
// travelling mic → device buffer → graph hadn't all arrived, so the last
// ~50ms of every take — the tail of the final word — was simply gone (one of
// Sam's takes ends at full speech level, cut mid-sound). finishWavTake now
// waits a short grace before flushing so the in-flight tail lands.
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

// How long stop() keeps capturing before sealing the file. The audio still in
// flight (mic hardware → device buffer → the worklet) measured ~50ms on a
// wired mic; Bluetooth chains run several times that. The grace lands inside
// the take as a beat of trailing room tone, which is what a recording that
// wasn't cut off short is supposed to end with. It also means a limit-stop
// runs slightly past maxFrames — covered by the 0.9 headroom recording-limits
// builds into the frame cap.
const STOP_TAIL_GRACE_MS = 250

// The head-side counterpart (2026-08-14 round 3): the armed graph keeps the
// newest 200ms of countdown audio and the mark releases it as the take's
// head. An operator on a three-beep count-in comes in a breath EARLY when the
// count-in is working — Sam's first word kept losing its first consonant to
// the mark — and that early attack is performance, not noise (his standing
// ruling). NOT trimmed and NOT silenced: the caller anchors the take this
// much earlier on the timeline (see the modal's save), so the kept audio
// plays exactly where it was performed. 200ms covers human anticipation with
// room to spare while staying far clear of the countdown's last beep, which
// ends over a second before zero.
const PRE_ROLL_MS = 200

export type RecorderState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "recording"; startedAt: number }
  | {
      kind: "stopped"
      blob: Blob
      mimeType: string
      ext: string
      /** The WHOLE clip, pre-roll included — what a duration probe would say. */
      durationSec: number
      /** How much of the clip's head predates the mark (sample-exact, ms).
       *  The saver anchors the take this much before the line so the head
       *  plays where it was performed. 0 on the MediaRecorder path, which has
       *  no ring. Additive on purpose: consumers that mock this hook with
       *  partial objects read it as undefined and treat it as 0. */
      preRollMs?: number
    }
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
  // The ARMED graph: built by prewarm() during the countdown, running and
  // discarding, waiting for start() to mark it. Distinct from pcmRef — armed
  // means "no take yet". Kept across a cancelled countdown (like the warm mic
  // stream, it makes the retry instant); disposed by cleanup().
  const armedRef = useRef<PcmCaptureHandle | null>(null)
  const armedBuildRef = useRef<Promise<void> | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const elapsedMsRef = useRef(0)
  useEffect(() => { elapsedMsRef.current = elapsedMs }, [elapsedMs])

  const cleanup = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
    if (recorderRef.current) {
      try { if (recorderRef.current.state !== "inactive") recorderRef.current.stop() } catch {}
      recorderRef.current = null
    }
    if (armedRef.current) {
      try { armedRef.current.dispose() } catch {}
      armedRef.current = null
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
        // THE TAIL GRACE: keep capturing for a beat before sealing the file.
        // The audio of the final word is still travelling mic → device buffer
        // → worklet when the operator presses stop; flushing immediately cut
        // it off mid-sound. The graph stays connected through this wait, so
        // the in-flight tail lands as real samples.
        await new Promise((r) => setTimeout(r, STOP_TAIL_GRACE_MS))
        if (pcmRef.current !== handle) return
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
        const preRollMs = (handle.preRollFrames() / handle.sampleRate) * 1000
        // Release the mic only now: the flush above had to complete first, or
        // the last ~85ms — the end of the final word — is lost on every take.
        if (streamRef.current) {
          for (const t of streamRef.current.getTracks()) t.stop()
          streamRef.current = null
        }
        setStream(null)
        if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
        pcmRef.current = null
        setState({ kind: "stopped", blob, mimeType: "audio/wav", ext: "wav", durationSec, preRollMs })
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
    const format = formatOpt ?? getRecordingFormatPref()
    // Fetch the capture worklet while the countdown runs, so its round trip is
    // not charged to the operator's first word. Deliberately NOT awaited (the
    // mic prompt should go up immediately) and it never rejects.
    if (format === "wav") void preloadPcmCaptureModule()
    else if (armedRef.current) {
      // The pref flipped to webm between two countdowns (it is only lockable
      // once a take is in hand). An armed WAV graph from the earlier countdown
      // must not be adopted by a webm take — drop it.
      try { armedRef.current.dispose() } catch {}
      armedRef.current = null
    }
    if (!streamRef.current) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
        streamRef.current = s
        setStream(s)
      } catch {
        // Ignore — permission errors surface again when start() is called.
        return
      }
    }
    // ARM: bring the whole capture graph up NOW, during the countdown, running
    // and discarding. start() then collapses to mark() — a synchronous
    // bookmark — instead of AudioContext construction, a worklet fetch and a
    // head of zero-filled quanta, all of which used to land INSIDE the take as
    // dead air gluing the operator's voice that much later onto the timeline.
    // (This is the reversal of an older rule that prewarm must not build the
    // context: the leak it feared is closed by cleanup()/the pref branch above
    // disposing armedRef, and one armed context is the working maximum.)
    if (format !== "wav" || !isPcmCaptureSupported()) return
    if (armedRef.current || armedBuildRef.current) return
    const stream = streamRef.current
    armedBuildRef.current = (async () => {
      try {
        const limits = recordingLimitsFor(format, { maxBytes: maxBytesOpt })
        const handle = await startPcmCapture({
          stream,
          armed: true,
          preRollMs: PRE_ROLL_MS,
          maxFrames: limits.maxFrames,
          onLimit: () => finishWavTake(),
        })
        // reset() can land while the build is in flight — the mic it was
        // built on is already stopped, so the graph is a silent leak. Drop it.
        // So can a take: a countdown short enough (or a machine slow enough)
        // that zero arrived first sent start() down the un-armed path, and
        // this graph now has no take to serve and nothing to close it.
        if (streamRef.current !== stream || pcmRef.current) {
          try { handle.dispose() } catch {}
          return
        }
        armedRef.current = handle
      } catch {
        // Fall through silently — start() takes the un-prewarmed path.
      } finally {
        armedBuildRef.current = null
      }
    })()
    await armedBuildRef.current
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatOpt, maxBytesOpt, finishWavTake])

  const start = useCallback(async () => {
    if (state.kind === "requesting" || state.kind === "recording") return
    setElapsedMs(0)
    // Read the preference PLAINLY, not reactively: this pins the format for
    // this take. Subscribing would re-render the recorder on every pref change
    // and, worse, invite a flip mid-take that the captured bytes cannot honour.
    const format = formatOpt ?? getRecordingFormatPref()
    const limits = recordingLimitsFor(format, { maxBytes: maxBytesOpt })
    setWarnMs(limits.warnMs)

    // THE MARK PATH: prewarm() armed the graph during the countdown, so
    // starting a take is a bookmark, not a build. SYNCHRONOUS on purpose —
    // every await between "the operator was cued" and "sample 0" used to land
    // inside the take as dead air at the head, and that is the whole bug. No
    // "requesting" state on this path either: there is nothing to request.
    if (format === "wav" && armedRef.current) {
      const handle = armedRef.current
      armedRef.current = null
      pcmRef.current = handle
      pcmFinishRef.current = null
      handle.mark()
      const startedAt = Date.now()
      setState({ kind: "recording", startedAt })
      tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 100)
      return
    }

    setState({ kind: "requesting" })
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
