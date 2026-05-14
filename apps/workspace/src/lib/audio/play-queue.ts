// Single-file play queue. Walks cells in order, plays each cell's
// preferred audio (recording > generated voice), and advances on end. The
// caller hands us a snapshot of cells + a "fetch bytes for this attachment"
// callback so the queue stays decoupled from useCellAudio's complex
// per-cell state machine.

import { useSyncExternalStore } from "react"
import type { CellData } from "@/hooks/useCells"
import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useQueueState(): QueueState {
  return useSyncExternalStore(subscribe, () => state, () => IDLE)
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

async function fetchAudioBlob(
  attachmentUrl: string,
  projectId: string,
  fileId: string,
  session: FrontierSession,
): Promise<Blob> {
  const frontier = parseFrontierAudioUrl(attachmentUrl)
  if (frontier) {
    if (!session.jwt) throw new Error("Sign in to play audio")
    const bytes = await fetchCellAudio({
      projectId,
      fileId,
      audioId: frontier.audioId,
      ext: frontier.ext,
      getSyncToken: audioSyncTokenFetcherForSession(session),
    })
    return new Blob([bytes as BlobPart], { type: "audio/wav" })
  }
  // Direct (blob: / http) URL — let the browser fetch.
  const res = await fetch(attachmentUrl)
  if (!res.ok) throw new Error(`Failed to fetch audio (${res.status})`)
  return res.blob()
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

  let blob: Blob
  try {
    blob = await fetchAudioBlob(playable.url, ctx.projectId, cell.fileId, ctx.session)
  } catch (e) {
    if (seq !== currentSeq) return // superseded
    setState({ kind: "error", message: e instanceof Error ? e.message : String(e), cellId: cell.id })
    return
  }
  if (seq !== currentSeq) return

  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  currentAudio = audio
  currentUrl = url

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
    const next = findNextPlayable(ctx.cells, index + 1)
    if (next < 0) {
      setState(IDLE)
      disposeCurrent()
      return
    }
    void playAt(next)
  }
  audio.onerror = () => {
    if (seq !== currentSeq) return
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
