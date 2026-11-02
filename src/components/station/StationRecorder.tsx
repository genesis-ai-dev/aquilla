// Record now, in the Station itself (AQU-2327, slice 14; Sam, Nov 2): no
// recording window. Insert → Record now counts in at the cursor, the
// recording grows there in red as you speak and what comes after slides
// along, and Stop puts it in as an unsaved insert. A bar under the lane then
// asks Keep or Record again; Record again throws it away and counts in at
// the same place.
//
// The capture is the recording window's own (useAudioRecorder with holdMic,
// the count-in and its beep from the same settings), so a take made here gets
// the same armed start, pre-roll and tail as one made there. The level tap is
// opened during the count-in and pinned to the capture rate, for the reason
// AudioWaveform.tsx gives: opening it later reconfigures the mic mid-take.

import { useCallback, useEffect, useRef, useState } from "react"
import { Square } from "lucide-react"
import { COUNTDOWN_FROM, useCountdown } from "@/components/AudioRecorder/useCountdown"
import { probeMicPermission } from "@/components/AudioRecorder/probeMicPermission"
import { Button } from "@/components/ui/button"
import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { decodeToMono48k } from "@/lib/audio/decode-mono"
import { setMicHeld } from "@/lib/audio/mic-hold"
import { WAV_SAMPLE_RATE } from "@/lib/audio/recording-limits"
import { useT } from "@/lib/i18n/I18nProvider"
import { putStationPcm } from "@/lib/station/load"
import { formatStationLength } from "@/lib/station/time"
import { countdownStepMs, useRecordingCountdownBeep, useRecordingCountdownSpeed } from "@/lib/store/recording-countdown-pref"
import { STATION_EDIT_MAX_SEC, type StationEditor } from "./useStationEditor"

/** Level readings per second in the live drawing. */
const ENV_RATE = 100
/** How often the live drawing is handed to the lane. */
const DRAW_MS = 50

export type StationRecPhase =
  | { kind: "idle" }
  | { kind: "counting"; at: number }
  | { kind: "recording"; at: number }
  | { kind: "finishing"; at: number }
  /** Stopped and put in; Keep or Record again. `ops` is how many edits there
   *  were with it in, so another edit counts as keeping it. */
  | { kind: "pending"; at: number; len: number; ops: number }

export function useStationRecorder(ed: StationEditor, onMessage: (text: string) => void) {
  const t = useT()
  const recorder = useAudioRecorder({ holdMic: true })
  const countdown = useCountdown()
  const beep = useRecordingCountdownBeep()
  const step = countdownStepMs(useRecordingCountdownSpeed())
  const [phase, setPhaseState] = useState<StationRecPhase>({ kind: "idle" })
  // What the callbacks read, so they stay the same functions from render to
  // render: the level tap below must never be rebuilt mid-take.
  const phaseRef = useRef(phase)
  const setPhase = useCallback((p: StationRecPhase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])
  const edRef = useRef(ed)
  const recRef = useRef(recorder)
  const cfg = useRef({ countdown, beep, step, t, onMessage })
  useEffect(() => {
    edRef.current = ed
    recRef.current = recorder
    cfg.current = { countdown, beep, step, t, onMessage }
  })
  const busy = phase.kind !== "idle"

  // The mic is held from the count-in until Keep or a drop (Record again
  // keeps it: reopening it is what costs a take its first word).
  useEffect(() => {
    setMicHeld(busy)
  }, [busy])
  const letGo = useCallback(() => {
    cfg.current.countdown.cancel()
    recRef.current.reset()
    recRef.current.releaseMic?.()
    edRef.current.setLive(null)
    setPhase({ kind: "idle" })
  }, [setPhase])
  useEffect(
    () => () => {
      recRef.current.releaseMic?.()
      setMicHeld(false)
    },
    [],
  )

  const start = useCallback(
    (at: number) => {
      if (phaseRef.current.kind !== "idle" && phaseRef.current.kind !== "pending") return
      const e = edRef.current
      e.pause()
      e.select(at, at)
      setPhase({ kind: "counting", at })
      void probeMicPermission().then((perm) => {
        const { countdown, beep, step, t, onMessage } = cfg.current
        if (perm === "denied") {
          onMessage(t("editor.station.micDenied"))
          letGo()
          return
        }
        void recRef.current.prewarm()
        if (step == null) {
          void recRef.current.start()
          return
        }
        countdown.start({ beep, from: COUNTDOWN_FROM, stepMs: step, onDone: () => void recRef.current.start() })
      })
    },
    [letGo, setPhase],
  )

  /** Stop: during the count-in nothing was recorded, so it just ends. */
  const stop = useCallback(() => {
    const p = phaseRef.current
    if (p.kind === "counting") letGo()
    else if (p.kind === "recording") {
      setPhase({ kind: "finishing", at: p.at })
      recRef.current.stop()
    }
  }, [letGo, setPhase])

  // The recorder's own state moves the phase on.
  const state = recorder.state
  const handled = useRef<Blob | null>(null)
  useEffect(() => {
    const p = phaseRef.current
    const { t, onMessage } = cfg.current
    if (state.kind === "recording" && p.kind === "counting") setPhase({ kind: "recording", at: p.at })
    else if (state.kind === "error" && p.kind !== "idle") {
      onMessage(t("editor.station.recordFailed", { message: state.message }))
      letGo()
    } else if (state.kind === "stopped" && p.kind === "finishing" && handled.current !== state.blob) {
      const blob = state.blob
      handled.current = blob
      const ext = state.ext
      const cacheId = `station-rec-${Date.now().toString(36)}`
      void blob
        .arrayBuffer()
        .then((buf) => decodeToMono48k(new Uint8Array(buf)))
        .then((data) => {
          void audioCachePutBlob(cacheId, ext, blob)
          const e = edRef.current
          const before = e.ops.length
          e.setLive(null)
          const src = putStationPcm(cacheId, data)
          e.insertAudio(cacheId, src, { kind: "recording", cacheId, ext, label: t("editor.station.recordedInsert") })
          recRef.current.reset()
          setPhase({ kind: "pending", at: p.at, len: src.duration, ops: before + 1 })
        })
        .catch(() => {
          onMessage(t("editor.station.loadFailed"))
          letGo()
        })
    }
  }, [state, letGo, setPhase])

  // Another edit while it waits counts as keeping it.
  useEffect(() => {
    if (phase.kind === "pending" && ed.ops.length !== phase.ops) {
      recRef.current.releaseMic?.()
      setPhase({ kind: "idle" })
    }
  }, [phase, ed.ops.length, setPhase])

  const keep = useCallback(() => {
    if (phaseRef.current.kind !== "pending") return
    recRef.current.releaseMic?.()
    setPhase({ kind: "idle" })
  }, [setPhase])
  /** Take it back out; `again` counts in at the same place. */
  const discard = useCallback(
    (again: boolean) => {
      const p = phaseRef.current
      if (p.kind !== "pending") return
      const e = edRef.current
      if (e.ops.length === p.ops) e.undoUnsaved()
      e.select(p.at, p.at)
      if (again) {
        setPhase({ kind: "idle" })
        start(p.at)
      } else letGo()
    },
    [letGo, setPhase, start],
  )

  // The drawing: the tap opens with the stream (during the count-in) and
  // reads one peak a frame; while recording they go to the lane as a part
  // at the cursor, a few times a second.
  const stream = recorder.stream
  const recording = phase.kind === "recording"
  const at = phase.kind === "idle" ? null : phase.at
  useEffect(() => {
    if (!stream || at == null) return
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    let ctx: AudioContext
    try {
      ctx = new Ctx({ sampleRate: WAV_SAMPLE_RATE })
    } catch {
      ctx = new Ctx()
    }
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)
    const buf = new Float32Array(analyser.fftSize)
    let env = new Float32Array(ENV_RATE * 30)
    let n = 0
    let since: number | null = null
    let lastDraw = 0
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      if (phaseRef.current.kind !== "recording") {
        // Counting in, or between takes: the next one starts from nothing.
        if (phaseRef.current.kind === "counting") {
          since = null
          n = 0
        }
        return
      }
      const now = performance.now()
      since ??= now
      analyser.getFloatTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
      const upTo = Math.floor(((now - since) / 1000) * ENV_RATE)
      if (upTo >= env.length) {
        const grown = new Float32Array(Math.max(upTo + 1, env.length * 2))
        grown.set(env)
        env = grown
      }
      for (; n <= upTo; n++) env[n] = peak
      if (now - lastDraw >= DRAW_MS) {
        lastDraw = now
        const e = edRef.current
        e.setLive({ at, src: { data: env.subarray(0, n), rate: ENV_RATE } })
        // A recording the Station could no longer edit stops itself.
        if ((e.pcm?.duration ?? 0) + n / ENV_RATE >= STATION_EDIT_MAX_SEC) stop()
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      try {
        source.disconnect()
      } catch {}
      try {
        analyser.disconnect()
      } catch {}
      void ctx.close().catch(() => {})
    }
  }, [stream, at, stop])

  return {
    phase,
    busy,
    recording,
    count: countdown.count,
    elapsedMs: recorder.elapsedMs,
    start,
    stop,
    keep,
    again: () => discard(true),
    drop: () => discard(false),
  }
}

export type StationRec = ReturnType<typeof useStationRecorder>

/** Under the lane while recording, and after Stop: Keep or Record again. */
export function StationRecordBar({ rec }: { rec: StationRec }) {
  const t = useT()
  const p = rec.phase
  if (p.kind === "idle") return null
  const row = "flex shrink-0 items-center gap-2 px-3 pt-2 text-[12.5px]"
  if (p.kind === "pending") {
    return (
      <div data-testid="station-rec-bar" className={row}>
        <span className="text-foreground">
          {t("editor.station.newRecording")}
          <span className="ms-1.5 font-mono text-[11.5px] text-muted-foreground">{formatStationLength(p.len)}</span>
        </span>
        <Button type="button" size="sm" data-testid="station-rec-keep" onClick={rec.keep} className="text-[12.5px] font-medium">
          {t("editor.station.keepRecording")}
        </Button>
        <button
          type="button"
          data-testid="station-rec-again"
          onClick={rec.again}
          className="text-[12.5px] font-medium text-sky-700 hover:underline dark:text-sky-400"
        >
          {t("editor.station.recordAgain")}
        </button>
      </div>
    )
  }
  const counting = p.kind === "counting"
  return (
    <div data-testid="station-rec-bar" className={row}>
      <span className="inline-flex items-center gap-1.5 font-semibold text-red-600 dark:text-red-400">
        <span aria-hidden className={counting ? "size-2 rounded-full bg-red-600/40" : "size-2 animate-pulse rounded-full bg-red-600"} />
        {counting
          ? rec.count != null
            ? t("editor.station.recordFlagIn", { n: rec.count })
            : t("editor.station.recordFlagReady")
          : t("editor.station.recordingFor", { len: formatStationLength(rec.elapsedMs / 1000) })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-testid="station-rec-stop"
        disabled={p.kind === "finishing"}
        onClick={rec.stop}
        className="text-[12.5px] font-medium"
      >
        <Square className="size-3 fill-current text-red-600" />
        {t("editor.station.recordStop")}
      </Button>
    </div>
  )
}
