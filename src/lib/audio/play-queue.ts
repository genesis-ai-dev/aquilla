// Single-file play queue. Walks cells in order, plays each cell's
// preferred audio (recording > generated voice), and advances on end. The
// caller hands us a snapshot of cells + a "fetch bytes for this attachment"
// callback so the queue stays decoupled from useCellAudio's complex
// per-cell state machine.

import { useSyncExternalStore } from "react"
import type { CellData } from "@/hooks/useCells"
import { fetchCellAudio, getCellAudioStreamUrl, parseFrontierAudioUrl } from "./upload"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { audioCacheGet, audioCachePut } from "./bytes-cache"
import { audioMimeForExt } from "./mime"
import type { FrontierSession } from "@/lib/frontier/types"
import { setActiveAudio, clearActiveAudioIf, type ActiveAudioController } from "./audio-coordinator"

export type QueueState =
  | { kind: "idle" }
  | { kind: "loading"; cellIndex: number; cellId: string }
  | { kind: "playing"; cellIndex: number; cellId: string }
  | { kind: "paused"; cellIndex: number; cellId: string }
  | { kind: "error"; message: string; cellId?: string }

const IDLE: QueueState = { kind: "idle" }
let state: QueueState = IDLE
const listeners = new Set<() => void>()

function notify(): void { for (const l of listeners) l() }

function setState(next: QueueState): void {
  state = next
  notify()
}

export function getQueueState(): QueueState { return state }

/**
 * True when an error is `fetchCellAudio`'s missing-bytes 404 sentinel — the R2
 * object for a `frontier-audio://` clip doesn't exist (deleted, or an upload
 * that never completed). Kept distinct from transient/auth failures so the
 * queue can skip the dead clip and surface a clear "missing" state instead of
 * dead-ending on the raw `audio not found (404): not found` as if playback were
 * simply broken.
 */
export function isMissingAudioError(e: unknown): boolean {
  if (e && typeof e === "object" && "status" in e && (e as { status?: unknown }).status === 404) {
    return true
  }
  return e instanceof Error && e.message.includes("audio not found (404)")
}

/** User-facing copy for the "this clip has no bytes to play" state. */
export const MISSING_AUDIO_MESSAGE = "This clip's audio is missing."

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useQueueState(): QueueState {
  return useSyncExternalStore(subscribe, () => state, () => IDLE)
}

// ── Playback progress (time/duration/rate/volume) ───────────────────────────
// Kept in a separate store from QueueState so the ~4×/sec timeupdate ticks only
// re-render the playback bar's scrubber, not every QueueState consumer.

export interface QueueProgress {
  currentTime: number
  duration: number
  /** Playback speed multiplier (persists across tracks). */
  rate: number
  /** 0..1 volume (persists across tracks). */
  volume: number
}

let progress: QueueProgress = { currentTime: 0, duration: 0, rate: 1, volume: 1 }
const progressListeners = new Set<() => void>()

function notifyProgress(): void { for (const l of progressListeners) l() }

function setProgress(patch: Partial<QueueProgress>): void {
  progress = { ...progress, ...patch }
  notifyProgress()
}

function subscribeProgress(listener: () => void): () => void {
  progressListeners.add(listener)
  return () => { progressListeners.delete(listener) }
}

export function useQueueProgress(): QueueProgress {
  return useSyncExternalStore(subscribeProgress, () => progress, () => progress)
}

// ── Single owned audio element ──────────────────────────────────────────────

let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null
let currentSeq = 0

const coordinatorController: ActiveAudioController = {
  isPlaying: () => Boolean(currentAudio && !currentAudio.paused),
  play: async () => { try { await currentAudio?.play() } catch { /* coordinator-driven, ignore */ } },
  pause: () => { currentAudio?.pause() },
}

function disposeCurrent(): void {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.src = ""
    currentAudio = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
  clearActiveAudioIf(coordinatorController)
  setProgress({ currentTime: 0, duration: 0 })
}

/** Seek within the currently-playing clip (seconds). */
export function seekQueue(seconds: number): void {
  if (!currentAudio) return
  const d = currentAudio.duration
  currentAudio.currentTime = Number.isFinite(d) ? Math.max(0, Math.min(seconds, d)) : Math.max(0, seconds)
  setProgress({ currentTime: currentAudio.currentTime })
}

/** Set playback speed for the queue (applies live + to subsequent tracks). */
export function setQueueRate(rate: number): void {
  if (currentAudio) currentAudio.playbackRate = rate
  setProgress({ rate })
}

/** Set queue volume 0..1 (applies live + to subsequent tracks). */
export function setQueueVolume(vol: number): void {
  const v = Math.max(0, Math.min(1, vol))
  if (currentAudio) currentAudio.volume = v
  setProgress({ volume: v })
}

// ── Per-cell audio resolution ───────────────────────────────────────────────

/**
 * Pick the "best" audio attachment for a cell. Prefers a real recording
 * over a generated voice. Returns the attachment URL if one is playable.
 */
function pickPlayableAudio(cell: CellData): { audioId: string; url: string } | undefined {
  const ids = [cell.selectedAudioId, cell.selectedGeneratedVoiceAudioId]
  for (const id of ids) {
    if (!id) continue
    const att = cell.attachments?.[id]
    if (!att || att.isDeleted) continue
    return { audioId: id, url: att.url }
  }
  return undefined
}

interface ResolvedAudioSrc {
  src: string
  /** Object URL to revoke on dispose (blob playback only). */
  objectUrl: string | null
  /** True when src is an authenticated streaming URL — on media error the
   *  queue retries once via the full-bytes blob path. */
  streaming: boolean
  frontier: { audioId: string; ext: string } | null
}

/** Full-download fallback: fetch all bytes, write through to the OPFS cache,
 *  return a blob object URL. */
async function fetchFullBlobUrl(
  frontier: { audioId: string; ext: string },
  projectId: string,
  fileId: string,
  session: FrontierSession,
): Promise<string> {
  const bytes = await fetchCellAudio({
    projectId,
    fileId,
    audioId: frontier.audioId,
    ext: frontier.ext,
    getSyncToken: audioSyncTokenFetcherForSession(session),
  })
  void audioCachePut(frontier.audioId, frontier.ext, bytes)
  // MIME must match the real container — Safari/Firefox reject mistyped or
  // typeless blobs with a bare onerror ("Audio failed to load").
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: audioMimeForExt(frontier.ext) }))
}

/**
 * Resolve a cell attachment to a playable `<audio src>`. Progressive-playback
 * order: OPFS-cached bytes (offline-friendly, zero network) → authenticated
 * streaming URL (first sound before the download finishes; Range/206 handles
 * seeks) → full-download blob when no stream URL could be minted.
 */
async function resolveAudioSrc(
  attachmentUrl: string,
  projectId: string,
  fileId: string,
  session: FrontierSession,
): Promise<ResolvedAudioSrc> {
  const frontier = parseFrontierAudioUrl(attachmentUrl)
  if (!frontier) {
    // Direct (blob: / http) URL — the media element streams it natively.
    return { src: attachmentUrl, objectUrl: null, streaming: false, frontier: null }
  }
  if (!session.jwt) throw new Error("Sign in to play audio")
  const cached = await audioCacheGet(frontier.audioId, frontier.ext)
  if (cached) {
    const url = URL.createObjectURL(
      new Blob([cached as BlobPart], { type: audioMimeForExt(frontier.ext) }),
    )
    return { src: url, objectUrl: url, streaming: false, frontier }
  }
  const streamUrl = await getCellAudioStreamUrl({
    projectId,
    fileId,
    audioId: frontier.audioId,
    ext: frontier.ext,
    getSyncToken: audioSyncTokenFetcherForSession(session),
  })
  if (streamUrl) return { src: streamUrl, objectUrl: null, streaming: true, frontier }
  const url = await fetchFullBlobUrl(frontier, projectId, fileId, session)
  return { src: url, objectUrl: url, streaming: false, frontier }
}

// ── Public API ──────────────────────────────────────────────────────────────

interface PlayContext {
  cells: CellData[]
  projectId: string
  session: FrontierSession
  /** Called when a cell starts playing — useful for scrolling into view. */
  onCellChange?: (cellIndex: number, cellId: string) => void
}

let activeContext: PlayContext | null = null

/** Returns the next cell index (>= startIndex) that has playable audio. */
function findNextPlayable(cells: CellData[], startIndex: number): number {
  for (let i = startIndex; i < cells.length; i++) {
    if (pickPlayableAudio(cells[i])) return i
  }
  return -1
}

function findPrevPlayable(cells: CellData[], startIndex: number): number {
  for (let i = startIndex; i >= 0; i--) {
    if (pickPlayableAudio(cells[i])) return i
  }
  return -1
}

/**
 * The [start, end) window (seconds, on the CLIP's clock) the queue must play
 * for a cell, or null to play the whole attachment.
 *
 * Media segments (`medium: "media"`) share one imported clip across N cells,
 * each windowed by startTime/endTime — ignoring the window plays the full file
 * once per cell. Text cells' startTime/endTime are subtitle timings on the
 * video timeline, NOT offsets into their own recording, so they get no window.
 */
export function trimWindowForCell(cell: CellData): { start: number; end: number } | null {
  if (cell.medium !== "media") return null
  const { startTime, endTime } = cell
  if (typeof startTime !== "number" || typeof endTime !== "number") return null
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
  if (endTime <= startTime) return null
  return { start: startTime, end: endTime }
}

async function playAt(index: number): Promise<void> {
  const ctx = activeContext
  if (!ctx) return
  const cell = ctx.cells[index]
  if (!cell) {
    setState(IDLE)
    disposeCurrent()
    return
  }
  const playable = pickPlayableAudio(cell)
  if (!playable) {
    // Hop to next cell that has audio.
    const next = findNextPlayable(ctx.cells, index + 1)
    if (next < 0) {
      setState(IDLE)
      disposeCurrent()
      return
    }
    return playAt(next)
  }

  disposeCurrent()
  const seq = ++currentSeq
  setState({ kind: "loading", cellIndex: index, cellId: cell.id })
  ctx.onCellChange?.(index, cell.id)

  // A clip whose bytes are gone must not dead-end the whole transport: skip to
  // the next clip that has audio, and only surface a clear "missing" state when
  // no playable clip remains (rather than the misleading raw 404).
  const skipMissingFrom = (missingCellId: string): void => {
    const next = findNextPlayable(ctx.cells, index + 1)
    if (next >= 0) { void playAt(next); return }
    disposeCurrent()
    setState({ kind: "error", message: MISSING_AUDIO_MESSAGE, cellId: missingCellId })
  }

  let resolved: ResolvedAudioSrc
  try {
    resolved = await resolveAudioSrc(playable.url, ctx.projectId, cell.fileId, ctx.session)
  } catch (e) {
    if (seq !== currentSeq) return // superseded
    if (isMissingAudioError(e)) { skipMissingFrom(cell.id); return }
    setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
    return
  }
  if (seq !== currentSeq) {
    if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl)
    return
  }

  const audio = new Audio(resolved.src)
  currentAudio = audio
  currentUrl = resolved.objectUrl
  audio.playbackRate = progress.rate
  audio.volume = progress.volume
  const trim = trimWindowForCell(cell)
  setProgress({ currentTime: trim?.start ?? 0, duration: 0 })

  const advance = () => {
    const next = findNextPlayable(ctx.cells, index + 1)
    if (next < 0) {
      setState(IDLE)
      disposeCurrent()
      return
    }
    void playAt(next)
  }

  if (trim) {
    audio.onloadedmetadata = () => {
      if (seq !== currentSeq) return
      audio.currentTime = trim.start
    }
  }
  audio.ontimeupdate = () => {
    if (seq !== currentSeq) return
    // A media segment's window ends before the shared clip does — treat
    // reaching trim.end as this cell's "ended" and move to the next cell.
    if (trim && audio.currentTime >= trim.end) {
      audio.onpause = null // don't let the pause handler flash a "paused" state
      audio.pause()
      advance()
      return
    }
    setProgress({ currentTime: audio.currentTime })
  }
  audio.ondurationchange = () => {
    if (seq !== currentSeq) return
    if (Number.isFinite(audio.duration)) setProgress({ duration: audio.duration })
  }

  audio.onplay = () => {
    if (seq !== currentSeq) return
    setActiveAudio(coordinatorController)
    setState({ kind: "playing", cellIndex: index, cellId: cell.id })
  }
  audio.onpause = () => {
    if (seq !== currentSeq) return
    if (audio.ended) return
    setState({ kind: "paused", cellIndex: index, cellId: cell.id })
  }
  audio.onended = () => {
    if (seq !== currentSeq) return
    advance()
  }
  let triedBlobFallback = false
  audio.onerror = () => {
    if (seq !== currentSeq) return
    // Streamed src failed (expired token, transient network) — retry once by
    // downloading the full bytes and swapping the element's src in place so
    // the wired handlers (onended advance, progress) carry over.
    if (resolved.streaming && resolved.frontier && !triedBlobFallback) {
      triedBlobFallback = true
      void (async () => {
        try {
          const url = await fetchFullBlobUrl(resolved.frontier!, ctx.projectId, cell.fileId, ctx.session)
          if (seq !== currentSeq) {
            URL.revokeObjectURL(url)
            return
          }
          currentUrl = url
          audio.src = url
          await audio.play()
        } catch (e) {
          if (seq !== currentSeq) return
          if (isMissingAudioError(e)) { skipMissingFrom(cell.id); return }
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
        }
      })()
      return
    }
    setState({ kind: "error", message: "Audio failed to load", cellId: cell.id })
  }

  try {
    await audio.play()
  } catch (e) {
    if (seq !== currentSeq) return
    setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
  }
}

/** Start playback at a specific cell index (or skip forward to the next
 *  cell with audio if the start index has none). */
export function startQueue(ctx: PlayContext, fromIndex: number): void {
  activeContext = ctx
  const start = findNextPlayable(ctx.cells, Math.max(0, fromIndex))
  if (start < 0) {
    setState(IDLE)
    disposeCurrent()
    return
  }
  void playAt(start)
}

export function pauseQueue(): void {
  currentAudio?.pause()
}

export async function resumeQueue(): Promise<void> {
  if (!currentAudio) return
  try { await currentAudio.play() } catch { /* user-driven, ignore */ }
}

export function stopQueue(): void {
  disposeCurrent()
  setState(IDLE)
  activeContext = null
}

export function skipForward(): void {
  if (!activeContext) return
  const cur = state.kind === "playing" || state.kind === "paused" || state.kind === "loading"
    ? state.cellIndex
    : -1
  const next = findNextPlayable(activeContext.cells, cur + 1)
  if (next < 0) {
    stopQueue()
    return
  }
  void playAt(next)
}

export function skipBack(): void {
  if (!activeContext) return
  const cur = state.kind === "playing" || state.kind === "paused" || state.kind === "loading"
    ? state.cellIndex
    : -1
  const prev = findPrevPlayable(activeContext.cells, cur - 1)
  if (prev < 0) return
  void playAt(prev)
}

/** Refresh the queue's snapshot of cells without restarting playback.
 *  Useful when the user generates voice mid-playback and we want the queue
 *  to reflect the new attachments on the next advance. */
export function updateQueueCells(cells: CellData[]): void {
  if (activeContext) activeContext.cells = cells
}

/** Whether any cell in the list has playable audio. Drives the bar's
 *  Play button enablement. */
export function hasAnyPlayableAudio(cells: CellData[]): boolean {
  return cells.some((c) => pickPlayableAudio(c) !== undefined)
}
