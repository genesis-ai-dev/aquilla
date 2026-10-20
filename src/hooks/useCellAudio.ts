// src/hooks/useCellAudio.ts
// React hook that loads per-cell audio on demand from sync-worker R2.
// Owns the HTMLAudioElement lifecycle and revokes the object URL on unmount /
// selectedAudioId change. Also exposes currentTime/seek and lazy peak
// decoding so that waveform UI and the play button can share one controller.

import { isOnline } from "@/lib/offline/connectivity"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import posthog from "@/lib/posthog"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchCellAudio, getCellAudioStreamUrl, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import { decodePeaks } from "@/lib/audio/peaks"
import { audioMimeForExt } from "@/lib/audio/mime"
import { peaksCacheGet, peaksCachePut } from "@/lib/audio/peaks-cache"
import { fetchPeaksSidecar, publishPeaksSidecarOnce } from "@/lib/audio/peaks-sidecar"
import { audioCacheGet, audioCachePut, audioCacheEvict } from "@/lib/audio/bytes-cache"
import { joinedClip } from "@/lib/audio/tail-cut"
import {
  type ActiveAudioController,
  claimActiveAudio,
  clearActiveAudioIf,
  getActiveAudio,
  notifyActiveAudioChanged,
  otherCopyOf,
  playingElsewhere,
  subscribeActiveAudio,
} from "@/lib/audio/audio-coordinator"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"

export type AudioErrorKind =
  | "pointer-missing"
  | "pointer-invalid"
  | "download-failed"
  | "audio-deleted"
  | "no-session"
  /** Not in the local cache and the server is unreachable (desktop offline). */
  | "offline-unavailable"

export interface AudioError {
  kind: AudioErrorKind
  message: string
}

/** Move a player's playhead. Safari refuses (throws) before the element knows
 *  enough of its media to seek; a refused move is simply not made, never an
 *  uncaught error in the middle of playback. */
function setPlayhead(a: HTMLMediaElement, t: number): void {
  try { a.currentTime = t } catch { /* not seekable yet */ }
}

/**
 * AQU-1767 (Sam's walk, 2026-10-15): a split take plays as ONE clip — its
 * pieces' audio joined — so nothing seeks between pieces. Every seek on a
 * playing element stalls Safari about a third of a second, sounding the old
 * position meanwhile: a click played the take's head and then jumped, and
 * every cut stuttered. The element then runs on the joined clip's clock;
 * these map it to and from the recording's, which every caller speaks.
 */
export interface JoinedClock {
  key: string
  spans: { start: number; end: number }[]
  offsets: number[]
  total: number
}

/** The parts of [start, end] that play, given the gaps that do not. */
export function playingSpans(
  start: number,
  end: number,
  gaps: readonly { start: number; end: number }[],
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  let at = start
  for (const g of [...gaps].sort((a, b) => a.start - b.start)) {
    if (g.start > at) spans.push({ start: at, end: Math.min(g.start, end) })
    at = Math.max(at, g.end)
  }
  if (end > at) spans.push({ start: at, end })
  return spans.filter((s) => s.end > s.start)
}

/** Which window and gaps a joined clip was built for. */
export function gapsKeyOf(tr: { start: number | null; end: number | null; gaps?: readonly { start: number; end: number }[] }): string {
  return `${tr.start ?? ""}-${tr.end ?? ""}~${(tr.gaps ?? []).map((g) => `${g.start}-${g.end}`).join(",")}`
}

export function joinedClockFor(key: string, spans: { start: number; end: number }[]): JoinedClock {
  const offsets: number[] = []
  let total = 0
  for (const s of spans) { offsets.push(total); total += s.end - s.start }
  return { key, spans, offsets, total }
}

/** Recording seconds → the joined clip's (a gap lands on the next piece). */
export function toJoinedSec(j: JoinedClock, t: number): number {
  for (let i = 0; i < j.spans.length; i++) {
    if (t < j.spans[i].start) return j.offsets[i]
    if (t < j.spans[i].end) return j.offsets[i] + (t - j.spans[i].start)
  }
  return j.total
}

/** The joined clip's seconds → the recording's. */
export function toRecordingSec(j: JoinedClock, x: number): number {
  for (let i = 0; i < j.spans.length; i++) {
    const len = j.spans[i].end - j.spans[i].start
    if (x < j.offsets[i] + len) return j.spans[i].start + Math.max(0, x - j.offsets[i])
  }
  return j.spans.length > 0 ? j.spans[j.spans.length - 1].end : 0
}

/** AQU-1767: where playback resumes when `t` lies in a gap that does not play, or null. */
export function gapEndAt(gaps: readonly { start: number; end: number }[] | undefined, t: number): number | null {
  if (!gaps) return null
  for (const g of gaps) if (t >= g.start && t < g.end - 0.005) return g.end
  return null
}

/** How far inside a trim window's end a seek lands — see `clampToTrim`. */
export const SEEK_END_GUARD_SEC = 0.05

/** "missing" = the clip's stored audio is permanently gone (404) — unlike
 *  "error" it is not retryable, so UI must not offer a retry affordance. */
export type PeaksState = "idle" | "loading" | "ready" | "error" | "missing" | "offline"

/** External http(s) clip attached by URL (timeline media layer) — streamed
 *  straight from its source, never copied into R2. Playback uses the media
 *  element directly (no CORS needed); byte-level features (peaks,
 *  transcription) fetch the bytes and need the host to allow CORS. */
const isRemoteMediaUrl = (url: string): boolean =>
  url.startsWith("https://") || url.startsWith("http://")

/** True only when we KNOW media can't be fetched: no network interface, or
 *  the desktop probe says the backend is down. Unknown (web, first probe
 *  pending) is not unreachable — the fetch gets its chance. */
async function mediaUnreachable(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true
  return (await isOnline()) === false
}

export interface UseCellAudioResult {
  /** "cloud" = server pointer exists but bytes not yet fetched. */
  state: "idle" | "cloud" | "loading" | "ready" | "error"
  error: AudioError | null
  isPlaying: boolean
  currentTime: number
  duration: number
  peaks: Float32Array | null
  peaksState: PeaksState
  play: () => Promise<void>
  pause: () => void
  seek: (t: number) => void
  /** Set playback volume 0..1. Applies live to the current element and to the
   *  next element created on play. */
  setVolume: (v: number) => void
  /** Constrain playback to a [start,end] window in seconds; null = clip edge.
   *  Both null (default) = unconstrained, byte-identical to no-trim behaviour.
   *  `gaps` (AQU-1767): stretches inside it that do not play — the space
   *  between a split take's pieces — skipped by playback, a seek and a play. */
  setTrim: (start: number | null, end: number | null, gaps?: readonly { start: number; end: number }[]) => void
  /** Decode and cache peaks for a target bin count. Safe to call repeatedly.
   *  Pass { force: true } to retry after a previous failure. */
  requestPeaks: (bins: number, opts?: { force?: boolean }) => Promise<void>
  /** Force-load the audio bytes (e.g. for transcription). */
  ensureBytes: () => Promise<Uint8Array>
}

export interface UseCellAudioOptions {
  /**
   * What of the playhead this caller shows, as a key: its reported
   * `currentTime` then moves only when the key changes, not every frame.
   *
   * A row that shows only which WORD is being spoken (the karaoke highlight)
   * passes the word's index. Without it the row re-rendered — with its whole
   * subtree — on every frame a take played anywhere, since one playback per
   * take made its hidden player follow the card's (2026-09-30: about 27
   * renders a second of the playing row; a second-long stall on a slow
   * device). Seeks, starts and stops still report at once.
   */
  timeKey?: (t: number) => unknown
}

export function useCellAudio(
  project: ProjectRecord,
  cell: CodexCell,
  fileId: string,
  opts: UseCellAudioOptions = {},
): UseCellAudioResult {
  const { session } = useFrontierSession()
  const t = useT()
  const [state, setState] = useState<UseCellAudioResult["state"]>("idle")
  const [error, setError] = useState<AudioError | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTimeState] = useState(0)
  // See `timeKey`: the per-frame writes go through `publishTime`, which skips
  // a frame whose key is the one last written; every other write is at once.
  const timeKeyRef = useRef(opts.timeKey)
  timeKeyRef.current = opts.timeKey
  const lastTimeKeyRef = useRef<{ key: unknown } | null>(null)
  const setCurrentTime = useCallback((t: number) => {
    const keyOf = timeKeyRef.current
    lastTimeKeyRef.current = keyOf ? { key: keyOf(t) } : null
    setCurrentTimeState(t)
  }, [])
  const publishTime = useCallback((t: number) => {
    const keyOf = timeKeyRef.current
    if (keyOf) {
      const key = keyOf(t)
      if (lastTimeKeyRef.current && Object.is(lastTimeKeyRef.current.key, key)) return
      lastTimeKeyRef.current = { key }
    }
    setCurrentTimeState(t)
  }, [])
  const [duration, setDuration] = useState(0)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [peaksState, setPeaksState] = useState<PeaksState>("idle")

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const bytesRef = useRef<Uint8Array | null>(null)
  const rafRef = useRef<number | null>(null)
  const peaksRequestedRef = useRef<number | null>(null)
  const bytesPromiseRef = useRef<Promise<Uint8Array> | null>(null)
  const peaksReadyRef = useRef(false)
  const volumeRef = useRef(1)
  const trimRef = useRef<{ start: number | null; end: number | null; gaps?: readonly { start: number; end: number }[] }>({ start: null, end: null })
  // AQU-1767: the joined clip's clock while the element plays one (see JoinedClock).
  const joinedRef = useRef<JoinedClock | null>(null)
  // AQU-1767: where a click asked a not-yet-loaded take to start, so it starts
  // THERE rather than at its head and then jumps.
  const pendingStartRef = useRef<number | null>(null)
  // AQU-1767: the element being made, so a second click waits for it.
  const creatingRef = useRef<Promise<void> | null>(null)
  // The recording's own length, for a window whose end is the clip's end.
  const recordingSecRef = useRef(0)
  /** The element's position on the recording's clock. */
  const elTime = (a: HTMLMediaElement): number => (joinedRef.current ? toRecordingSec(joinedRef.current, a.currentTime) : a.currentTime)
  /** Move the element to a position on the recording's clock. */
  const setElTime = (a: HTMLMediaElement, t: number): void => setPlayhead(a, joinedRef.current ? toJoinedSec(joinedRef.current, t) : t)

  // Keep the latest session reachable from the token fetcher without
  // recreating it on every session field update. The underlying token cache
  // lives at module scope in sync-token-fetcher.ts (shared across every
  // useCellAudio instance — a row's recorded + generated-voice audio share
  // one mint per (session, project, file) instead of each mounting its own
  // cache), so this useMemo only avoids pointless closure churn, not cache
  // loss.
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
  const seekRef = useRef<(t: number) => void>(() => undefined)
  const coordinatorControllerRef = useRef<ActiveAudioController | null>(null)
  const clipKeyRef = useRef<string | null>(null)
  // AQU-1767 (Sam's walk, 2026-10-15): two players of one take are COPIES only
  // while they play it the same way. The line's own play button played a split
  // take whole and raw, the Recording tab its pieces — and a click on the tab's
  // waveform was handed to the row's player, which played the gaps and ran
  // past the last piece. The window is part of which take this is.
  const elTimeRef = useRef<(a: HTMLMediaElement) => number>((a) => a.currentTime)
  elTimeRef.current = elTime
  const copyKeyRef = useRef<() => string | null>(() => null)
  copyKeyRef.current = () => {
    const key = clipKeyRef.current
    if (!key) return null
    const { start, end, gaps } = trimRef.current
    const sig = (n: number | null) => (n == null ? "" : n.toFixed(3))
    return `${key}@${sig(start)}-${sig(end)}${gaps?.length ? `~${gaps.map((g) => `${sig(g.start)}-${sig(g.end)}`).join(",")}` : ""}`
  }
  if (coordinatorControllerRef.current === null) {
    coordinatorControllerRef.current = {
      isPlaying: () => Boolean(audioRef.current && !audioRef.current.paused),
      play: () => playRef.current(),
      pause: () => pauseRef.current(),
      clipKey: () => copyKeyRef.current(),
      currentTime: () => (audioRef.current ? elTimeRef.current(audioRef.current) : 0),
      seek: (t: number) => seekRef.current(t),
    }
  }

  const selectedAudioId = cell.metadata?.selectedAudioId
  // Which take this is, across every waveform that shows it.
  const clipKey = selectedAudioId ? `${fileId}|${selectedAudioId}` : null
  clipKeyRef.current = clipKey
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
      bytesPromiseRef.current = null
      peaksRequestedRef.current = null
      peaksReadyRef.current = false
      // A trim belongs to ONE take. Carried across a swap it would play the
      // new take through the old one's window (AQU-1217); callers re-apply
      // theirs when the take they show changes.
      trimRef.current = { start: null, end: null }
      joinedRef.current = null
      pendingStartRef.current = null
      if (coordinatorControllerRef.current) clearActiveAudioIf(coordinatorControllerRef.current)
      setState("idle")
      setIsPlaying(false)
      setError(null)
      setCurrentTime(0)
      setDuration(0)
      setPeaks(null)
      setPeaksState("idle")
    }
  }, [selectedAudioId, setCurrentTime])

  // Derive "cloud" state: a frontier-audio:// pointer (or a remote http(s)
  // clip) exists but bytes are not yet in memory. Only set when in "idle"
  // state so we don't clobber an active loading/ready/error state.
  useEffect(() => {
    if (
      attachmentUrl &&
      (attachmentUrl.startsWith("frontier-audio://") || isRemoteMediaUrl(attachmentUrl)) &&
      !bytesRef.current &&
      !bytesPromiseRef.current
    ) {
      setState((s) => (s === "idle" ? "cloud" : s))
    }
  }, [attachmentUrl])

  const ensureBytes = useCallback(async (): Promise<Uint8Array> => {
    if (bytesRef.current) return bytesRef.current
    // Coalesce concurrent callers — the waveform's peak decode and the play
    // button (and, in the combined-clip editor, both at once) fire on the same
    // mount. Without this, two parallel fetches race and a transient failure on
    // one can flip shared state to "error" even though the other succeeded.
    if (bytesPromiseRef.current) return bytesPromiseRef.current

    if (!attachmentUrl) {
      throw { kind: "pointer-missing", message: t("audio.error.noAttachment") } as AudioError
    }

    if (isRemoteMediaUrl(attachmentUrl)) {
      // URL-attached clip: fetch the bytes straight from the source (peaks /
      // transcription). Requires the host to allow CORS — playback doesn't.
      const p = (async () => {
        try {
          const res = await fetch(attachmentUrl)
          if (!res.ok) throw new Error(`media fetch failed (${res.status})`)
          const bytes = new Uint8Array(await res.arrayBuffer())
          bytesRef.current = bytes
          return bytes
        } catch (e) {
          throw {
            kind: "download-failed",
            message: e instanceof Error ? e.message : String(e),
          } as AudioError
        }
      })()
      bytesPromiseRef.current = p
      try {
        return await p
      } finally {
        bytesPromiseRef.current = null
      }
    }

    const frontier = parseFrontierAudioUrl(attachmentUrl)
    if (!frontier) {
      // Legacy GitLab LFS attachments are no longer fetchable from codex-web;
      // surface this clearly so the UI can render a "needs re-record" state.
      throw {
        kind: "pointer-invalid",
        message: t("audio.error.legacyLfsUnsupported", { url: attachmentUrl }),
      } as AudioError
    }

    const p = (async () => {
      try {
        // L2 cache check (CACHE-5): audio is immutable per audioId, so a hit
        // here is always valid — no re-download needed. Checked BEFORE the
        // sign-in guard (FRO-355) so a locally-cached take still plays offline
        // / signed out; only the network fetch below needs a JWT.
        const cached = await audioCacheGet(frontier.audioId, frontier.ext)
        if (cached) {
          bytesRef.current = cached
          return cached
        }

        if (await mediaUnreachable()) {
          throw { kind: "offline-unavailable", message: t("audio.error.notAvailableOffline") } as AudioError
        }

        if (!sessionRef.current?.jwt) {
          throw { kind: "no-session", message: t("audio.error.notSignedIn") } as AudioError
        }

        const bytes = await fetchCellAudio({
          projectId: project.id,
          fileId,
          audioId: frontier.audioId,
          ext: frontier.ext,
          getSyncToken,
        })
        bytesRef.current = bytes
        // Write through to L2 cache; non-fatal if OPFS is unavailable.
        void audioCachePut(frontier.audioId, frontier.ext, bytes)
        return bytes
      } catch (e) {
        // Pass through already-typed AudioErrors (e.g. the no-session throw
        // above) instead of re-wrapping them as "download-failed".
        if (e && typeof e === "object" && "kind" in e) throw e
        // F10: distinguish permanent deletion (404) from transient errors.
        // 404 → "audio-deleted" so the UI can show "re-record" instead of
        // a generic error with a retry spinner.
        const is404 =
          (e && typeof e === "object" && "status" in e && (e as { status: unknown }).status === 404)
        if (is404) {
          // Evict any stale cached bytes for this audioId (e.g. partially
          // written entry from a previous failed upload).
          void audioCacheEvict(frontier.audioId, frontier.ext)
          throw {
            kind: "audio-deleted",
            message: t("audio.error.recordingDeleted"),
          } as AudioError
        }
        throw {
          kind: "download-failed",
          message: e instanceof Error ? e.message : String(e),
        } as AudioError
      }
    })()
    bytesPromiseRef.current = p
    try {
      return await p
    } finally {
      bytesPromiseRef.current = null
    }
  }, [attachmentUrl, project.id, fileId, getSyncToken, t])

  // The tick re-arms itself every frame. It schedules through this ref (kept
  // pointed at the latest closure just below) rather than by name, so each frame
  // runs the current callback (react-hooks/immutability).
  const tickPlayheadRef = useRef<() => void>(() => {})
  const tickPlayhead = useCallback(() => {
    const a = audioRef.current
    if (!a) return
    const { start, end } = trimRef.current
    const now = elTime(a)
    if (end != null && now >= end) {
      a.pause()
      setElTime(a, start ?? 0)
      setCurrentTime(start ?? 0)
      return // onpause → stopTicking
    }
    // AQU-1767: across the space between a split take's pieces (a joined
    // clip has none to cross).
    const pastGap = joinedRef.current ? null : gapEndAt(trimRef.current.gaps, now)
    if (pastGap != null) setPlayhead(a, pastGap)
    publishTime(elTime(a))
    rafRef.current = requestAnimationFrame(() => tickPlayheadRef.current())
  }, [publishTime, setCurrentTime])
  tickPlayheadRef.current = tickPlayhead

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
    // The take was last played from another of its copies: resume it THERE,
    // where it was left, rather than start a second playback from the top.
    const self = coordinatorControllerRef.current
    const other = self ? otherCopyOf(self, copyKeyRef.current()) : null
    if (other && !(audioRef.current && !audioRef.current.paused)) { await other.play(); return }
    // CLAIM, not just record: whatever else is sounding stops — another take,
    // or another copy of this one (Sam, 2026-09-29: the Audio view card and
    // the Recording tab under it played the same take on top of each other).
    if (coordinatorControllerRef.current) claimActiveAudio(coordinatorControllerRef.current)
    if (audioRef.current) {
      const a = audioRef.current
      const { start, end } = trimRef.current
      // Restart from the window start if we're outside it (e.g. ended at
      // trimEnd). `ended` covers a take trimmed only at its head that played to
      // the file's natural end: a replay would otherwise restart at 0 and play
      // the trimmed-off head (AQU-1217).
      const now = elTime(a)
      if (start != null && (a.ended || now < start || (end != null && now >= end - 0.01))) {
        setElTime(a, start)
      } else if (a.ended) {
        setElTime(a, 0)
      }
      const pastGap = joinedRef.current ? null : gapEndAt(trimRef.current.gaps, elTime(a))
      if (pastGap != null) setPlayhead(a, pastGap)
      try { await a.play() } catch (e) {
        console.error("[useCellAudio] play() rejected", e)
      }
      return
    }
    if (creatingRef.current) {
      // A second click while the first is still loading the take: one
      // element, not two playing on top of each other.
      await creatingRef.current
      const made = audioRef.current as HTMLAudioElement | null
      if (made && pendingStartRef.current != null && made.readyState >= 1) {
        setElTime(made, pendingStartRef.current)
        pendingStartRef.current = null
      }
      return
    }
    let created: () => void = () => {}
    creatingRef.current = new Promise<void>((resolve) => { created = resolve })
    setState("loading")
    setError(null)
    // One-shot guard: if the streamed src errors (expired token, transient
    // network blip, misbehaving proxy), retry exactly once via the full-bytes
    // blob path before surfacing an error.
    let triedBlobFallback = false
    // Stamp the real container type on playback blobs — Safari/Firefox trust
    // the declared type and fail a typeless Blob with a bare onerror.
    const blobOpts = (): BlobPropertyBag | undefined => {
      const ext = attachmentUrl ? parseFrontierAudioUrl(attachmentUrl)?.ext : undefined
      return ext ? { type: audioMimeForExt(ext) } : undefined
    }
    const makeElement = (src: string, streaming: boolean): HTMLAudioElement => {
      const audio = new Audio(src)
      audio.volume = volumeRef.current
      audio.onerror = () => {
        setIsPlaying(false)
        stopTicking()
        if (streaming && !triedBlobFallback) {
          triedBlobFallback = true
          void (async () => {
            try {
              const bytes = await ensureBytes()
              if (audioRef.current !== audio) return // superseded / unmounted
              const blobSrc = URL.createObjectURL(new Blob([bytes as BlobPart], blobOpts()))
              urlRef.current = blobSrc
              const next = makeElement(blobSrc, false)
              setState("ready")
              await next.play()
            } catch (e) {
              const err = (e && typeof e === "object" && "kind" in e)
                ? (e as AudioError)
                : { kind: "download-failed" as const, message: String(e) }
              posthog.captureException(e instanceof Error ? e : new Error(err.message), {
                audio_error_kind: err.kind,
              })
              setError(err)
              setState("error")
            }
          })()
          return
        }
        posthog.captureException(new Error("audio element failed to stream media source"), {
          audio_error_kind: "download-failed",
        })
        setError({ kind: "download-failed", message: t("audio.error.streamingFailed") })
        setState("error")
      }
      // Each change is announced: the take's other copies mirror it.
      audio.onplay = () => { setIsPlaying(true); startTicking(); notifyActiveAudioChanged() }
      audio.onpause = () => { setIsPlaying(false); stopTicking(); notifyActiveAudioChanged() }
      audio.onended = () => { setIsPlaying(false); stopTicking(); notifyActiveAudioChanged() }
      audio.onloadedmetadata = () => {
        // A joined clip is shorter than the recording the waveform draws.
        if (Number.isFinite(audio.duration) && !joinedRef.current) setDuration(audio.duration)
        const { start } = trimRef.current
        // Where a click asked it to start, or the window's start.
        const at = pendingStartRef.current ?? start
        pendingStartRef.current = null
        // Never seek a clip whose length is still unknown: a MediaRecorder
        // webm reports Infinity until indexed, and seeking one makes Chrome
        // fire \`ended\` at once, so the take is never heard (play-queue's
        // wireOverlayElement refuses the same seek).
        if (at != null && Number.isFinite(audio.duration) && (at > 0 || joinedRef.current)) {
          setElTime(audio, at)
          setCurrentTime(at)
        }
      }
      audio.ontimeupdate = () => {
        const { start, end } = trimRef.current
        const now = elTime(audio)
        if (end != null && now >= end) {
          audio.pause()
          setElTime(audio, start ?? 0)
          setCurrentTime(start ?? 0)
          return
        }
        const pastGap = joinedRef.current ? null : gapEndAt(trimRef.current.gaps, now)
        if (pastGap != null) setPlayhead(audio, pastGap)
        publishTime(elTime(audio))
      }
      audioRef.current = audio
      return audio
    }
    try {
      let src: string
      let streamingSrc = false
      const frontier = attachmentUrl ? parseFrontierAudioUrl(attachmentUrl) : null
      // AQU-1767: a split take plays as one joined clip of its pieces.
      joinedRef.current = null
      const tr = trimRef.current
      const recEnd = tr.end ?? (recordingSecRef.current > 0 ? recordingSecRef.current : null)
      const joined = frontier && tr.gaps && tr.gaps.length > 0 && recEnd != null
        ? await (async () => {
            const bytes = bytesRef.current ?? (await audioCacheGet(frontier.audioId, frontier.ext)) ?? (await ensureBytes())
            bytesRef.current = bytes
            const spans = playingSpans(tr.start ?? 0, recEnd, tr.gaps ?? [])
            const blob = spans.length > 0 ? await joinedClip(bytes, frontier.ext, spans) : null
            return blob ? { blob, clock: joinedClockFor(gapsKeyOf(tr), spans) } : null
          })()
        : null
      if (joined) {
        src = URL.createObjectURL(joined.blob)
        urlRef.current = src
        joinedRef.current = joined.clock
      } else if (attachmentUrl && isRemoteMediaUrl(attachmentUrl)) {
        if (await mediaUnreachable()) {
          throw { kind: "offline-unavailable", message: t("audio.error.notAvailableOffline") } as AudioError
        }
        // Stream straight from the source URL — no byte copy, no object URL.
        src = attachmentUrl
      } else if (frontier) {
        // Progressive playback: bytes already at hand (L1 ref / OPFS L2 —
        // also the offline path) play from a blob; otherwise point the
        // element at the authenticated streaming URL so first sound doesn't
        // wait for the full download. Peaks/transcription still fetch full
        // bytes via ensureBytes.
        let bytes = bytesRef.current
        if (!bytes) {
          bytes = await audioCacheGet(frontier.audioId, frontier.ext)
          if (bytes) bytesRef.current = bytes
        }
        if (bytes) {
          src = URL.createObjectURL(new Blob([bytes as BlobPart], blobOpts()))
          urlRef.current = src
        } else {
          if (await mediaUnreachable()) {
            throw { kind: "offline-unavailable", message: t("audio.error.notAvailableOffline") } as AudioError
          }
          const streamUrl = sessionRef.current?.jwt
            ? await getCellAudioStreamUrl({
                projectId: project.id,
                fileId,
                audioId: frontier.audioId,
                ext: frontier.ext,
                getSyncToken,
              })
            : null
          if (streamUrl) {
            src = streamUrl
            streamingSrc = true
          } else {
            // No token (anonymous / no access) — ensureBytes surfaces the
            // precise AudioError (no-session, download-failed, …).
            const fetched = await ensureBytes()
            src = URL.createObjectURL(new Blob([fetched as BlobPart], blobOpts()))
            urlRef.current = src
          }
        }
      } else {
        // Non-frontier pointer — ensureBytes throws the right AudioError
        // (pointer-missing / pointer-invalid).
        const fetched = await ensureBytes()
        src = URL.createObjectURL(new Blob([fetched as BlobPart], blobOpts()))
        urlRef.current = src
      }
      const audio = makeElement(src, streamingSrc)
      setState("ready")
      // A click asked for a place: be there before the first sound, not after.
      if (pendingStartRef.current != null && audio.readyState < 1) {
        await new Promise<void>((resolve) => {
          audio.addEventListener("loadedmetadata", () => resolve(), { once: true })
          audio.addEventListener("error", () => resolve(), { once: true })
        })
      }
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
      posthog.captureException(e instanceof Error ? e : new Error(err.message), {
        audio_error_kind: err.kind,
      })
      setError(err)
      setState("error")
    } finally {
      creatingRef.current = null
      created()
    }
  }, [attachmentUrl, project.id, fileId, getSyncToken, ensureBytes, startTicking, stopTicking, t, publishTime, setCurrentTime]) // eslint-disable-line react-hooks/exhaustive-deps -- elTime/setElTime read refs only

  const pause = useCallback(() => {
    const own = audioRef.current
    if (own && !own.paused) { own.pause(); return }
    // Sounding from another copy of this take: stop it there.
    const self = coordinatorControllerRef.current
    if (self) playingElsewhere(self, copyKeyRef.current())?.pause()
  }, [])

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    volumeRef.current = clamped
    if (audioRef.current) audioRef.current.volume = clamped
  }, [])

  const setTrim = useCallback((start: number | null, end: number | null, gaps?: readonly { start: number; end: number }[]) => {
    const next = gaps && gaps.length > 0 ? { start, end, gaps } : { start, end }
    // AQU-1767: an element playing a joined clip of OTHER pieces (or one that
    // should now be joined, or no longer) is let go; the next play builds the
    // right one.
    const built = joinedRef.current?.key ?? null
    const wanted = next.gaps ? gapsKeyOf(next) : null
    trimRef.current = next
    const a = audioRef.current
    if (a && built !== wanted) {
      a.onplay = a.onpause = a.onended = a.onerror = a.onloadedmetadata = a.ontimeupdate = null
      a.pause()
      audioRef.current = null
      joinedRef.current = null
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
      stopTicking()
      setIsPlaying(false)
      if (coordinatorControllerRef.current) clearActiveAudioIf(coordinatorControllerRef.current)
      return
    }
    if (a && start != null && Number.isFinite(a.duration)) {
      // Snap the playhead into the new window if it fell outside.
      const now = elTime(a)
      if (now < start || (end != null && now > end)) {
        setElTime(a, start)
        setCurrentTime(start)
      }
    }
  }, [setCurrentTime, stopTicking]) // eslint-disable-line react-hooks/exhaustive-deps -- elTime/setElTime read refs only

  // A seek lands a hair INSIDE the window's end. Landing exactly on it is
  // "reached the end" to the tick, which pauses and rewinds — so a drag into
  // the trimmed-off tail made every pointer move pause, rewind, restart and
  // seek again (Sam, 2026-09-29: scrubbing while playing froze the app).
  const clampToTrim = (t: number, dur: number): number => {
    const lo = trimRef.current.start ?? 0
    const hi = trimRef.current.end ?? dur
    const inWindow = Math.max(lo, Math.min(t, Math.max(lo, hi - SEEK_END_GUARD_SEC)))
    // A click in the space between pieces starts the next piece.
    return gapEndAt(trimRef.current.gaps, inWindow) ?? inWindow
  }

  // A drag reports every pointer move; the element is moved once a frame, to
  // the latest of them. Moving it more often only queues seeks it cannot keep
  // up with — on a streamed take each one is a new range request.
  const pendingSeekRef = useRef<number | null>(null)
  const seekFrameRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (seekFrameRef.current != null) cancelAnimationFrame(seekFrameRef.current)
  }, [])

  const seek = useCallback((t: number) => {
    // Scrubbing a copy of the take another copy last played moves THAT one.
    const self = coordinatorControllerRef.current
    const other = self ? otherCopyOf(self, copyKeyRef.current()) : null
    if (other?.seek) { other.seek(t); return }
    const a = audioRef.current
    // The recording's length (a joined clip's element is shorter).
    const recDur = (el: HTMLMediaElement, fallback: number) =>
      joinedRef.current ? (recordingSecRef.current || fallback) : Number.isFinite(el.duration) ? el.duration : fallback
    if (a) {
      pendingSeekRef.current = t
      // The readout follows the pointer at once; the element, next frame.
      setCurrentTime(clampToTrim(t, recDur(a, t)))
      if (seekFrameRef.current != null) return
      seekFrameRef.current = requestAnimationFrame(() => {
        seekFrameRef.current = null
        const target = pendingSeekRef.current
        pendingSeekRef.current = null
        const el = audioRef.current
        if (!el || target == null) return
        const clamped = clampToTrim(target, recDur(el, target))
        setElTime(el, clamped)
        setCurrentTime(clamped)
        // Clicking the waveform implies "play from here" — resume if paused
        // (covers the post-end and post-pause cases where audioRef is set but
        // playback has stopped).
        if (el.paused) void playRef.current()
      })
      return
    }
    // No audio loaded yet: start playing it AT the click (AQU-1767 — it used
    // to start at the take's head and then jump there, and in Safari the jump
    // took a third of a second, sounding the head meanwhile). Not awaited, so
    // the click feels immediate.
    const at = clampToTrim(t, recordingSecRef.current || t)
    pendingStartRef.current = at
    setCurrentTime(at)
    void play()
  }, [play, setCurrentTime]) // eslint-disable-line react-hooks/exhaustive-deps -- setElTime reads refs only

  const requestPeaks = useCallback(async (bins: number, opts?: { force?: boolean }) => {
    if (!attachmentUrl || !selectedAudioId) return
    if (!opts?.force && peaksRequestedRef.current === bins) return
    peaksRequestedRef.current = bins
    if (opts?.force) peaksReadyRef.current = false
    setPeaksState("loading")
    try {
      const cached = await peaksCacheGet(selectedAudioId, bins)
      if (cached) {
        setPeaks(cached)
        peaksReadyRef.current = true
        setPeaksState("ready")
        return
      }
      // AQU-2095: the stored shape, a few hundred bytes, before the recording
      // itself. A card in the Audio view used to download its whole take to
      // draw a 20px rectangle — a chapter of them is ~400KB and most of a
      // minute on 3G. The clip is now only fetched to play (ensureBytes), or
      // when no sidecar has been published for it yet. Length comes from the
      // attachment, as it already does on a peaks-cache hit.
      const frontier = attachmentUrl ? parseFrontierAudioUrl(attachmentUrl) : null
      if (frontier) {
        const stored = await fetchPeaksSidecar({
          projectId: project.id,
          fileId,
          audioId: frontier.audioId,
          ext: frontier.ext,
          getSyncToken,
        })
        if (stored && stored.length === bins) {
          setPeaks(stored)
          peaksReadyRef.current = true
          setPeaksState("ready")
          try { await peaksCachePut(selectedAudioId, stored) } catch { /* non-fatal */ }
          return
        }
      }
      const bytes = await ensureBytes()
      const decoded = await decodePeaks(bytes, bins)
      setPeaks(decoded.peaks)
      setDuration((d) => (d > 0 ? d : decoded.duration))
      peaksReadyRef.current = true
      setPeaksState("ready")
      try { await peaksCachePut(selectedAudioId, decoded.peaks) } catch { /* non-fatal */ }
      // Having paid for the clip, leave its shape behind for everyone else.
      if (frontier) {
        publishPeaksSidecarOnce({
          projectId: project.id,
          fileId,
          audioId: frontier.audioId,
          ext: frontier.ext,
          getSyncToken,
          peaks: decoded.peaks,
        })
      }
    } catch (e) {
      const kind = (e && typeof e === "object" && "kind" in e) ? (e as AudioError).kind : null
      // pointer-missing / no-session are expected in many real-world states
      // (no recording for this cell yet, anonymous session); audio-deleted is a
      // handled permanent state. Don't spam the console for any of them.
      if (kind !== "pointer-missing" && kind !== "no-session" && kind !== "audio-deleted" && kind !== "offline-unavailable") {
        console.error("[useCellAudio] requestPeaks failed", e)
      }
      // Leave peaksRequestedRef pinned to bins so we don't retry in a loop.
      // The user can re-mount (e.g. scroll the row out and back) to retry.
      // Don't downgrade a waveform that already decoded successfully — a
      // second, redundant request failing must not blank a good render.
      // audio-deleted (permanent 404) → non-retryable "missing", not "error".
      if (!peaksReadyRef.current) {
        setPeaksState(kind === "audio-deleted" ? "missing" : kind === "offline-unavailable" ? "offline" : "error")
      }
    }
  }, [attachmentUrl, selectedAudioId, ensureBytes, project.id, fileId, getSyncToken])

  // Keep refs in sync so the coordinator-registered controller delegates to
  // the latest closures, not the ones captured at registration time.
  playRef.current = play
  pauseRef.current = pause
  seekRef.current = seek

  // ── One take, one playback ──────────────────────────────────────────────
  // While another copy of this take is the one last played (the Audio view
  // card above the Recording tab, the recorder over either), this copy shows
  // that playback as its own — playing or paused, at that copy's position —
  // and its button, play and scrub all go there (see play, pause, seek).
  const [mirrored, setMirrored] = useState<ActiveAudioController | null>(null)
  const [mirrorPlaying, setMirrorPlaying] = useState(false)
  const [mirrorTime, setMirrorTimeState] = useState(0)
  const lastMirrorKeyRef = useRef<{ key: unknown } | null>(null)
  const setMirrorTime = useCallback((t: number, perFrame = false) => {
    const keyOf = timeKeyRef.current
    if (keyOf) {
      const key = keyOf(t)
      if (perFrame && lastMirrorKeyRef.current && Object.is(lastMirrorKeyRef.current.key, key)) return
      lastMirrorKeyRef.current = { key }
    }
    setMirrorTimeState(t)
  }, [])
  useEffect(() => {
    const self = coordinatorControllerRef.current
    if (!self) return
    const check = () => {
      const other = otherCopyOf(self, copyKeyRef.current())
      setMirrored(other)
      setMirrorPlaying(Boolean(other?.isPlaying()))
      if (other?.currentTime) setMirrorTime(other.currentTime())
    }
    check()
    return subscribeActiveAudio(check)
  }, [clipKey, setMirrorTime])
  useEffect(() => {
    if (!mirrorPlaying || !mirrored?.currentTime) return
    let frame = requestAnimationFrame(function follow() {
      // Stale once the coordinator has moved on; the check above clears it.
      if (getActiveAudio() === mirrored) setMirrorTime(mirrored.currentTime?.() ?? 0, true)
      frame = requestAnimationFrame(follow)
    })
    return () => cancelAnimationFrame(frame)
  }, [mirrored, mirrorPlaying, setMirrorTime])
  const mirroring = mirrored != null

  // The element (or the decode) reports the real length, but a waveform
  // served from the peaks cache arrives with neither — and with no length the
  // strip can't place its playhead or a trim. The attachment already carries
  // the length the recorder or importer measured; use it until then.
  const attachmentDurationSec = typeof attachment?.durationMs === "number" && attachment.durationMs > 0
    ? attachment.durationMs / 1000
    : 0
  recordingSecRef.current = duration > 0 ? duration : attachmentDurationSec

  return {
    state,
    error,
    isPlaying: isPlaying || mirrorPlaying,
    currentTime: mirroring ? mirrorTime : currentTime,
    duration: duration > 0 ? duration : attachmentDurationSec,
    peaks, peaksState,
    play, pause, seek, setVolume, setTrim, requestPeaks, ensureBytes,
  }
}
