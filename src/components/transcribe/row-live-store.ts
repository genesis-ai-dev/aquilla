// What a Transcribe row is doing right now, kept per row.
//
// This used to be two maps in TranscribeEditor's state, so every step of every
// row — and every token of a streaming cleanup — re-rendered the whole list
// (docs/decisions/0013: state lives in the smallest component that needs it).
// A row now subscribes to its own entry, so a step renders that one row, and
// the list does not render while a row works.
//
// A cleanup reports once per token. Those reports are coalesced: the entry
// takes the newest text at most once per animation frame, which also bounds
// the diff the row draws over it to once per frame. A change of STAGE is never
// held back — "listening", "heard" and the outcome land the moment they are
// reported.

import { useSyncExternalStore } from "react"
import type { RowProgress, SparkleOutcome } from "@/lib/transcript-cleanup/run"

export type RowStatus = { kind: "idle" } | { kind: "working"; progress: RowProgress } | SparkleOutcome

/** What a run has produced that the row's own data does not show yet: the
 *  save is queued and the cell is being read back. Shown in the meantime. */
export interface RowLive {
  /** `null`: nothing heard — a clear that the row's data does not show yet. */
  heard?: string | null
  transcript?: string
  /** The transcript shown is a cleanup that has just landed. */
  aiCleaned?: boolean
}

export interface RowLiveState {
  status: RowStatus
  live?: RowLive
}

/** A pass over several rows ("Transcribe all", "Clean up selected"). */
export interface BatchProgress {
  done: number
  total: number
}

const IDLE: RowLiveState = { status: { kind: "idle" } }

type Listener = () => void

export interface RowLiveStore {
  get(cellId: string): RowLiveState
  subscribe(cellId: string, listener: Listener): () => void
  /** Set a row's status. A token of the cleanup already being written is
   *  coalesced to one update per frame; anything else lands at once. */
  setStatus(cellId: string, status: RowStatus): void
  /** Merge into what the row shows ahead of its data; `null` drops it. */
  setLive(cellId: string, live: RowLive | null): void
  getBatch(): BatchProgress | null
  subscribeBatch(listener: Listener): () => void
  setBatch(next: BatchProgress | null | ((prev: BatchProgress | null) => BatchProgress | null)): void
  /** Cancel the pending frame (the view is going away). */
  dispose(): void
}

type Frame = { cancel: () => void }

/** One animation frame, or a timer where there are none (a hidden tab gets no
 *  frames, and a streamed token must not wait for the tab to come back). */
function nextFrame(run: () => void): Frame {
  const visible = typeof document === "undefined" || document.visibilityState !== "hidden"
  if (visible && typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run)
    return { cancel: () => cancelAnimationFrame(id) }
  }
  const id = setTimeout(run, 16)
  return { cancel: () => clearTimeout(id) }
}

const isWriting = (status: RowStatus | undefined): boolean =>
  status?.kind === "working" && status.progress.stage === "cleaning"

export function createRowLiveStore(): RowLiveStore {
  const entries = new Map<string, RowLiveState>()
  const listeners = new Map<string, Set<Listener>>()
  const batchListeners = new Set<Listener>()
  let batch: BatchProgress | null = null
  /** The newest token-level status per row, waiting for the frame. */
  const pending = new Map<string, RowStatus>()
  let frame: Frame | null = null

  const emit = (cellId: string) => {
    listeners.get(cellId)?.forEach((listener) => listener())
  }
  const write = (cellId: string, next: RowLiveState) => {
    if (next.status.kind === "idle" && !next.live) entries.delete(cellId)
    else entries.set(cellId, next)
    emit(cellId)
  }
  const flush = () => {
    frame = null
    const due = [...pending]
    pending.clear()
    for (const [cellId, status] of due) write(cellId, { ...entries.get(cellId), status })
  }

  return {
    get: (cellId) => entries.get(cellId) ?? IDLE,
    subscribe(cellId, listener) {
      let set = listeners.get(cellId)
      if (!set) {
        set = new Set()
        listeners.set(cellId, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(cellId)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(cellId)
      }
    },
    setStatus(cellId, status) {
      const shown = pending.get(cellId) ?? entries.get(cellId)?.status
      if (isWriting(status) && isWriting(shown)) {
        // One more token of a reply already on screen: the frame takes the
        // newest text, however many tokens arrived since the last one.
        pending.set(cellId, status)
        frame ??= nextFrame(flush)
        return
      }
      pending.delete(cellId)
      write(cellId, { ...entries.get(cellId), status })
    },
    setLive(cellId, live) {
      const entry = entries.get(cellId)
      if (live) {
        write(cellId, { status: entry?.status ?? IDLE.status, live: { ...entry?.live, ...live } })
      } else if (entry?.live) {
        write(cellId, { status: entry.status })
      }
    },
    getBatch: () => batch,
    subscribeBatch(listener) {
      batchListeners.add(listener)
      return () => { batchListeners.delete(listener) }
    },
    setBatch(next) {
      const value = typeof next === "function" ? next(batch) : next
      if (value === batch) return
      batch = value
      batchListeners.forEach((listener) => listener())
    },
    dispose() {
      frame?.cancel()
      frame = null
      pending.clear()
    },
  }
}

/** One row's entry. The component re-renders when THIS row's entry changes. */
export function useRowLive(store: RowLiveStore, cellId: string): RowLiveState {
  return useSyncExternalStore(
    (listener) => store.subscribe(cellId, listener),
    () => store.get(cellId),
    () => IDLE,
  )
}

/** The running pass's progress, for the one element that shows it. */
export function useBatchProgress(store: RowLiveStore): BatchProgress | null {
  return useSyncExternalStore(store.subscribeBatch, store.getBatch, () => null)
}
