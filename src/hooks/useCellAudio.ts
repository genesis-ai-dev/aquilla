// src/hooks/useCellAudio.ts
// React hook that loads per-cell audio on demand from sync-worker R2.
// Owns the HTMLAudioElement lifecycle and revokes the object URL on unmount /
// selectedAudioId change. Also exposes currentTime/seek and lazy peak
// decoding so that waveform UI and the play button can share one controller.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import { decodePeaks } from "@/lib/audio/peaks"
import { peaksCacheGet, peaksCachePut } from "@/lib/audio/peaks-cache"
import {
  type ActiveAudioController,
  clearActiveAudioIf,
  setActiveAudio,
} from "@/lib/audio/audio-coordinator"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

export type AudioErrorKind =
  | "pointer-missing"
  | "pointer-invalid"
  | "download-failed"
  | "no-session"

export interface AudioError {
  kind: AudioErrorKind
  message: string
}

export type PeaksState = "idle" | "loading" | "ready" | "error"

export interface UseCellAudioResult {
  state: "idle" | "loading" | "ready" | "error"
  error: AudioError | null
  isPlaying: boolean
  currentTime: number
  duration: number
  peaks: Float32Array | null
  peaksState: PeaksState
  play: () => Promise<void>
  pause: () => void
  seek: (t: number) => void
  /** Decode and cache peaks for a target bin count. Safe to call repeatedly.
   *  Pass { force: true } to retry after a previous failure. */
  requestPeaks: (bins: number, opts?: { force?: boolean }) => Promise<void>
  /** Force-load the audio bytes (e.g. for transcription). */
  ensureBytes: () => Promise<Uint8Array>
}

export function useCellAudio(
  project: ProjectRecord,
  cell: CodexCell,
  fileId: string,
): UseCellAudioResult {
  const { session } = useFrontierSession()
  const [state, setState] = useState<UseCellAudioResult["state"]>("idle")
  const [error, setError] = useState<AudioError | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [peaksState, setPeaksState] = useState<PeaksState>("idle")

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const bytesRef = useRef<Uint8Array | null>(null)
  const rafRef = useRef<number | null>(null)
  const peaksRequestedRef = useRef<number | null>(null)

  // Keep the latest session reachable from the cached token fetcher without
  // recreating it (and trashing the per-(project,file) token cache) on every
  // session field update.
  const sessionRef = useRef(session)
  useEffect(() => { sessionRef.current = session }, [session])
  const getSyncToken = useMemo(
    () => makeAudioSyncTokenFetcher(() => sessionRef.current),
    [],
  )

  // The play/pause callbacks are recreated every render; the coordinator
  // needs stable references it can call later. Stash the latest callbacks in
  // refs and expose a delegating ActiveAudioController that always reads
  // current ones.
  const playRef = useRef<() => Promise<void>>(async () => undefined)
  const pauseRef = useRef<() => void>(() => undefined)
  const coordinatorControllerRef = useRef<ActiveAudioController | null>(null)
  if (coordinatorControllerRef.current === null) {
    coordinatorControllerRef.current = {
      isPlaying: () => Boolean(audioRef.current && !audioRef.current.paused),
      play: () => playRef.current(),
      pause: () => pauseRef.current(),
    }
  }

  const selectedAudioId = cell.metadata?.selectedAudioId
  const attachment = selectedAudioId
    ? cell.metadata?.attachments?.[selectedAudioId]
    : undefined
  const attachmentUrl = attachment?.url

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
      bytesRef.current = null
      peaksRequestedRef.current = null
      if (coordinatorControllerRef.current) clearActiveAudioIf(coordinatorControllerRef.current)
      setState("idle")
      setIsPlaying(false)
      setError(null)
      setCurrentTime(0)
      setDuration(0)
      setPeaks(null)
      setPeaksState("idle")
    }
  }, [selectedAudioId])

  const ensureBytes = useCallback(async (): Promise<Uint8Array> => {
    if (bytesRef.current) return bytesRef.current
    if (!attachmentUrl) {
      throw { kind: "pointer-missing", message: "No audio attachment on this cell" } as AudioError
    }

    const frontier = parseFrontierAudioUrl(attachmentUrl)
    if (!frontier) {
      // Legacy GitLab LFS attachments are no longer fetchable from codex-web;
      // surface this clearly so the UI can render a "needs re-record" state.
      throw {
        kind: "pointer-invalid",
        message: `Unsupported audio URL (legacy LFS): ${attachmentUrl}`,
      } as AudioError
    }

    if (!sessionRef.current?.jwt) {
      throw { kind: "no-session", message: "Not signed in" } as AudioError
    }

    try {
      const bytes = await fetchCellAudio({
        projectId: project.id,
        fileId,
        audioId: frontier.audioId,
        ext: frontier.ext,
        getSyncToken,
      })
      bytesRef.current = bytes
      return bytes
    } catch (e) {
      throw {
        kind: "download-failed",
        message: e instanceof Error ? e.message : String(e),
      } as AudioError
    }
  }, [attachmentUrl, project.id, fileId, getSyncToken])

  const tickPlayhead = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    setCurrentTime(a.currentTime)
    rafRef.current = requestAnimationFrame(tickPlayhead)
  }, [])

  const startTicking = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(tickPlayhead)
  }, [tickPlayhead])

  const stopTicking = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const play = useCallback(async () => {
    if (coordinatorControllerRef.current) setActiveAudio(coordinatorControllerRef.current)
    if (audioRef.current) {
      try { await audioRef.current.play() } catch (e) {
        console.error("[useCellAudio] play() rejected", e)
      }
      return
    }
    setState("loading")
    setError(null)
    try {
      const bytes = await ensureBytes()
      const blob = new Blob([bytes as BlobPart])
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const audio = new Audio(url)
      audio.onplay = () => { setIsPlaying(true); startTicking() }
      audio.onpause = () => { setIsPlaying(false); stopTicking() }
      audio.onended = () => { setIsPlaying(false); stopTicking() }
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) setDuration(audio.duration)
      }
      audio.ontimeupdate = () => setCurrentTime(audio.currentTime)
      audioRef.current = audio
      setState("ready")
      try {
        await audio.play()
      } catch (e) {
        console.error("[useCellAudio] play() rejected on fresh audio", e)
      }
    } catch (e) {
      const err = (e && typeof e === "object" && "kind" in e)
        ? (e as AudioError)
        : { kind: "download-failed" as const, message: String(e) }
      console.error("[useCellAudio]", err)
      setError(err)
      setState("error")
    }
  }, [ensureBytes, startTicking, stopTicking])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const seek = useCallback((t: number) => {
    const a = audioRef.current
    if (a) {
      const clamped = Math.max(0, Math.min(t, Number.isFinite(a.duration) ? a.duration : t))
      a.currentTime = clamped
      setCurrentTime(clamped)
      // Clicking the waveform implies "play from here" — resume if paused
      // (covers the post-end and post-pause cases where audioRef is set but
      // playback has stopped).
      if (a.paused) void play()
      return
    }
    // No audio loaded yet — kick off play and let the user-initiated promise
    // resolve, then seek. We deliberately don't await here so the click feels
    // immediate; ontimeupdate will eventually catch the playhead up.
    void (async () => {
      await play()
      const a2 = audioRef.current
      if (!a2) return
      const clamped = Math.max(0, Math.min(t, Number.isFinite(a2.duration) ? a2.duration : t))
      a2.currentTime = clamped
      setCurrentTime(clamped)
    })()
  }, [play])

  const requestPeaks = useCallback(async (bins: number, opts?: { force?: boolean }) => {
    if (!attachmentUrl || !selectedAudioId) return
    if (!opts?.force && peaksRequestedRef.current === bins) return
    peaksRequestedRef.current = bins
    setPeaksState("loading")
    try {
      const cached = await peaksCacheGet(selectedAudioId, bins)
      if (cached) {
        setPeaks(cached)
        setPeaksState("ready")
        return
      }
      const bytes = await ensureBytes()
      const decoded = await decodePeaks(bytes, bins)
      setPeaks(decoded.peaks)
      setDuration((d) => (d > 0 ? d : decoded.duration))
      setPeaksState("ready")
      try { await peaksCachePut(selectedAudioId, decoded.peaks) } catch { /* non-fatal */ }
    } catch (e) {
      const kind = (e && typeof e === "object" && "kind" in e) ? (e as AudioError).kind : null
      // pointer-missing / no-session are expected in many real-world states
      // (no recording for this cell yet, anonymous session). Don't spam the console.
      if (kind !== "pointer-missing" && kind !== "no-session") {
        console.error("[useCellAudio] requestPeaks failed", e)
      }
      // Leave peaksRequestedRef pinned to bins so we don't retry in a loop.
      // The user can re-mount (e.g. scroll the row out and back) to retry.
      setPeaksState("error")
    }
  }, [attachmentUrl, selectedAudioId, ensureBytes])

  // Keep refs in sync so the coordinator-registered controller delegates to
  // the latest closures, not the ones captured at registration time.
  playRef.current = play
  pauseRef.current = pause

  return {
    state, error, isPlaying, currentTime, duration, peaks, peaksState,
    play, pause, seek, requestPeaks, ensureBytes,
  }
}
