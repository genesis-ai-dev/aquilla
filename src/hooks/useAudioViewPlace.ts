// The Audio view's one place to play from, carried out on the play queue — the
// bottom bar's player. The rules are lib/audio/audio-view-place.ts. (AQU-1642
// follow-up; Sam, 2026-10-17)

import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import {
  getQueueState,
  pauseQueue,
  resumeQueue,
  seekQueueInCell,
  startQueueAtCell,
  stopQueue,
} from "@/lib/audio/play-queue"
import {
  placeOnCardPress,
  placeOnMenuPress,
  placeOnSelect,
  placeOnWaveformPick,
  type PlaceStep,
  type RunOn,
} from "@/lib/audio/audio-view-place"

/** What a press needs to open the run: the bar's own context. */
export interface AudioViewPlaceContext {
  /** The file's cells with their takes merged in, as the bar plays them. */
  cells: CellData[]
  projectId: string
  session: FrontierSession | null
  /** The bar's "the run moved to this line" (it scrolls the line into view). */
  onActiveCell?: (cellId: string) => void
}

export interface AudioViewPlace {
  /** The verse the next Play starts from once the run has stopped. */
  startCellId: string | null
  /** A verse was selected: clicked or tabbed into anywhere but its play controls. */
  select: (cellId: string) => void
  /** The card's corner button. */
  pressCard: (cellId: string) => void
  /** ⋯ Play audio. */
  pressMenu: (cellId: string) => void
  /** A click inside the card's waveform, at a second of its clip. */
  pickOnWaveform: (cellId: string, atSeconds: number) => void
}

/**
 * `contextRef` is read at press time only, so the caller fills it in from an
 * effect once the file's cells are known — later than this hook is called. Bind
 * it to a `…Ref`-named variable: react-hooks/immutability treats what a hook
 * returns as frozen, and only recognises `<…Ref>.current` as a ref write.
 */
export function useAudioViewPlace(fileId: string | null): {
  place: AudioViewPlace
  contextRef: MutableRefObject<AudioViewPlaceContext | null>
} {
  const contextRef = useRef<AudioViewPlaceContext | null>(null)
  // Keyed by file, so another file never starts from this one's verse.
  const [start, setStart] = useState<{ fileId: string | null; cellId: string } | null>(null)
  const fileIdRef = useRef(fileId)
  fileIdRef.current = fileId

  const runOn = useCallback((): RunOn => {
    const s = getQueueState()
    if (s.kind !== "playing" && s.kind !== "loading" && s.kind !== "paused") return null
    if (!contextRef.current?.cells.some((c) => c.id === s.cellId)) return null
    return { cellId: s.cellId, kind: s.kind }
  }, [])

  const open = useCallback((cellId: string, opts: { atSeconds?: number; play: boolean }) => {
    const ctx = contextRef.current
    if (!ctx?.session?.jwt) return
    const index = ctx.cells.findIndex((c) => c.id === cellId)
    if (index < 0) return
    const { onActiveCell } = ctx
    startQueueAtCell(
      {
        cells: ctx.cells,
        projectId: ctx.projectId,
        session: ctx.session,
        onCellChange: (_, id) => onActiveCell?.(id),
      },
      index,
      opts,
    )
  }, [])

  const apply = useCallback((cellId: string, step: PlaceStep) => {
    setStart({ fileId: fileIdRef.current, cellId })
    switch (step.kind) {
      case "none":
        return
      case "stop":
        stopQueue()
        return
      case "pause":
        pauseQueue()
        return
      case "resume":
        void resumeQueue()
        return
      case "seek": {
        if (seekQueueInCell(cellId, step.atSeconds)) return
        // The run left this verse between the decision and now: open it here.
        const run = runOn()
        open(cellId, { atSeconds: step.atSeconds, play: run != null && run.kind !== "paused" })
        return
      }
      case "start":
        open(cellId, { ...(step.atSeconds != null ? { atSeconds: step.atSeconds } : {}), play: step.play })
    }
  }, [open, runOn])

  const select = useCallback((cellId: string) => apply(cellId, placeOnSelect(runOn())), [apply, runOn])
  const pressCard = useCallback((cellId: string) => apply(cellId, placeOnCardPress(runOn(), cellId)), [apply, runOn])
  const pressMenu = useCallback((cellId: string) => apply(cellId, placeOnMenuPress(runOn(), cellId)), [apply, runOn])
  const pickOnWaveform = useCallback(
    (cellId: string, atSeconds: number) => apply(cellId, placeOnWaveformPick(runOn(), cellId, atSeconds)),
    [apply, runOn],
  )

  const startCellId = start && start.fileId === fileId ? start.cellId : null
  const place = useMemo<AudioViewPlace>(
    () => ({ startCellId, select, pressCard, pressMenu, pickOnWaveform }),
    [startCellId, select, pressCard, pressMenu, pickOnWaveform],
  )
  return { place, contextRef }
}
