// The just-recorded take, playable within its kept window. (AQU-1210)
//
// Replaces the preview's bare `<audio controls>`, which played the whole blob
// and knew nothing of a trim. This speaks the same controller shape as
// useCellAudio, so the preview draws on the same TakeWaveform as every saved
// take — the operator trims the take they just recorded with exactly the lines
// they will later see on the Recording tab.
//
// Playback is an ordinary <audio> element over a WAV blob (prepareTakeBlob
// re-encodes a compressed take so the element can seek it), constrained to the
// window the way useCellAudio constrains a saved take. No AudioContext is
// opened: the recorder is holding the microphone.

import { useCallback, useEffect, useRef, useState } from "react"
import type { UseCellAudioResult } from "@/hooks/useCellAudio"
import { prepareTakeBlob, type PreparedTake } from "@/lib/audio/blob-peaks"
import { WAVEFORM_BINS } from "@/lib/audio/peaks-loader"
import { claimActiveAudio, clearActiveAudioIf, type ActiveAudioController } from "@/lib/audio/audio-coordinator"

interface Prepared extends PreparedTake {
  source: Blob
  url: string
}

export function usePreviewTake(blob: Blob | null): UseCellAudioResult {
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [failedFor, setFailedFor] = useState<Blob | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const trimRef = useRef<{ start: number | null; end: number | null }>({ start: null, end: null })
  const controllerRef = useRef<ActiveAudioController | null>(null)

  // ── Prepare the blob: peaks and a seekable copy ───────────────────────
  useEffect(() => {
    if (!blob) return
    let cancelled = false
    let url: string | null = null
    void prepareTakeBlob(blob, WAVEFORM_BINS).then(
      (p) => {
        if (cancelled) return
        url = URL.createObjectURL(p.playable)
        setPrepared({ ...p, source: blob, url })
      },
      () => { if (!cancelled) setFailedFor(blob) },
    )
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
      const a = audioRef.current
      if (a) { a.pause(); audioRef.current = null }
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      if (controllerRef.current) clearActiveAudioIf(controllerRef.current)
    }
  }, [blob])

  const live = prepared && prepared.source === blob ? prepared : null
  const peaksState: UseCellAudioResult["peaksState"] = !blob
    ? "idle"
    : live
      ? "ready"
      : failedFor === blob
        ? "error"
        : "loading"

  // ── Playback, held inside the window ──────────────────────────────────
  const stopTick = () => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }
  const tickRef = useRef<() => void>(() => {})
  const tick = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    const { start, end } = trimRef.current
    if (end != null && a.currentTime >= end) {
      a.pause()
      a.currentTime = start ?? 0
      setCurrentTime(start ?? 0)
      return
    }
    setCurrentTime(a.currentTime)
    rafRef.current = requestAnimationFrame(() => tickRef.current())
  }, [])
  useEffect(() => { tickRef.current = tick }, [tick])

  const pause = useCallback(() => { audioRef.current?.pause() }, [])

  const controller = useCallback((): ActiveAudioController => {
    if (!controllerRef.current) {
      controllerRef.current = {
        isPlaying: () => Boolean(audioRef.current && !audioRef.current.paused),
        play: async () => {},
        pause: () => audioRef.current?.pause(),
      }
    }
    return controllerRef.current
  }, [])

  const element = useCallback((): HTMLAudioElement | null => {
    if (!live) return null
    if (audioRef.current) return audioRef.current
    const a = new Audio(live.url)
    a.onplay = () => {
      setIsPlaying(true)
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(() => tickRef.current())
    }
    a.onpause = () => { setIsPlaying(false); stopTick() }
    a.onended = () => { setIsPlaying(false); stopTick() }
    audioRef.current = a
    return a
  }, [live])

  const play = useCallback(async () => {
    const a = element()
    if (!a) return
    claimActiveAudio(controller())
    const { start, end } = trimRef.current
    const from = start ?? 0
    if (a.ended || a.currentTime < from || (end != null && a.currentTime >= end - 0.01)) {
      a.currentTime = from
      setCurrentTime(from)
    }
    try { await a.play() } catch { /* autoplay refusal: nothing to do */ }
  }, [element, controller])

  const seek = useCallback((t: number) => {
    const a = element()
    if (!a) return
    const dur = live?.durationSec ?? 0
    const lo = trimRef.current.start ?? 0
    const hi = trimRef.current.end ?? dur
    const clamped = Math.max(lo, Math.min(t, hi))
    a.currentTime = clamped
    setCurrentTime(clamped)
    if (a.paused) void play()
  }, [element, live, play])

  const setTrim = useCallback((start: number | null, end: number | null) => {
    trimRef.current = { start, end }
    const a = audioRef.current
    if (a && start != null && (a.currentTime < start || (end != null && a.currentTime > end))) {
      a.currentTime = start
      setCurrentTime(start)
    }
  }, [])

  const requestPeaks = useCallback(async () => {}, [])
  const setVolume = useCallback(() => {}, [])
  const ensureBytes = useCallback(async () => new Uint8Array(await (blob ?? new Blob()).arrayBuffer()), [blob])

  return {
    state: live ? "ready" : blob ? "loading" : "idle",
    error: null,
    isPlaying: live ? isPlaying : false,
    currentTime: live ? currentTime : 0,
    duration: live?.durationSec ?? 0,
    peaks: live?.peaks ?? null,
    peaksState,
    play,
    pause,
    seek,
    setVolume,
    setTrim,
    requestPeaks,
    ensureBytes,
  }
}
