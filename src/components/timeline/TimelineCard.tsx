// A single timeline clip. Positioned by time; drag the body to move and drag
// the edge grips to stretch start/end. Commits once on pointer-up via onRetime
// (seconds); the parent converts to ms and emits cell.retime. Hand-rolled with
// window-level pointer listeners (robust when the pointer leaves the card, and
// testable under happy-dom). Read-only files disable drag but still select.

import { useState } from "react"
import { cn } from "@/lib/utils"
import { secToPx, pxToSec, clampRange } from "@/lib/timeline/scale"
import { fmtClock } from "./format"
import type { CellData } from "@/hooks/useCells"

const MIN_DUR_SEC = 0.2

type DragMode = "move" | "resize-l" | "resize-r"

export interface TimelineCardProps {
  cell: CellData
  pxPerSec: number
  /** Time (s) at the left edge of the track; usually 0. */
  laneStartSec: number
  variant: "subtitle" | "dialogue"
  selected: boolean
  editable: boolean
  onSelect(cellId: string): void
  /** Final bounds in seconds, fired once on pointer-up. */
  onRetime(cellId: string, startSec: number, endSec: number): void
}

export function TimelineCard({
  cell,
  pxPerSec,
  laneStartSec,
  variant,
  selected,
  editable,
  onSelect,
  onRetime,
}: TimelineCardProps) {
  const startSec = cell.startTime ?? 0
  const endSec = cell.endTime ?? startSec + MIN_DUR_SEC
  const [drag, setDrag] = useState<{ mode: DragMode; dx: number } | null>(null)

  // Live preview geometry while dragging; committed values come from props.
  let left = secToPx(startSec - laneStartSec, pxPerSec)
  let width = secToPx(endSec - startSec, pxPerSec)
  if (drag) {
    if (drag.mode === "move") left += drag.dx
    else if (drag.mode === "resize-l") {
      left += drag.dx
      width -= drag.dx
    } else width += drag.dx
  }
  width = Math.max(width, secToPx(MIN_DUR_SEC, pxPerSec))

  function beginDrag(mode: DragMode, e: React.PointerEvent) {
    if (!editable) return
    e.stopPropagation()
    const startX = e.clientX
    try {
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* happy-dom / unsupported — window listeners still work */
    }
    setDrag({ mode, dx: 0 })
    const onMove = (ev: PointerEvent) => setDrag((d) => (d ? { ...d, dx: ev.clientX - startX } : d))
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setDrag(null)
      const dSec = pxToSec(ev.clientX - startX, pxPerSec)
      let ns = startSec
      let ne = endSec
      if (mode === "move") {
        ns = startSec + dSec
        ne = endSec + dSec
      } else if (mode === "resize-l") ns = startSec + dSec
      else ne = endSec + dSec
      const clamped = clampRange(ns, ne, MIN_DUR_SEC)
      if (clamped.startSec !== startSec || clamped.endSec !== endSec) {
        onRetime(cell.id, clamped.startSec, clamped.endSec)
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const isDialogue = variant === "dialogue"
  const label =
    (isDialogue ? cell.transcription || cell.original : cell.original) || cell.cellLabel || "—"
  const castName =
    cell.metadata && typeof cell.metadata.cast_name === "string"
      ? (cell.metadata.cast_name as string)
      : null

  return (
    <div
      data-testid={`tl-card-${cell.id}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(cell.id)}
      onPointerDown={(e) => beginDrag("move", e)}
      className={cn(
        "group absolute top-2.5 flex h-[46px] touch-none select-none flex-col justify-center gap-0.5 overflow-hidden rounded-lg border px-2.5 shadow-sm transition-shadow",
        editable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        isDialogue
          ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200"
          : "border-border bg-card text-foreground",
        selected && "z-10 ring-2 ring-sky-500 ring-offset-1 ring-offset-background",
        !selected && "hover:z-10 hover:shadow-md",
      )}
      style={{ left: `${left}px`, width: `${width}px` }}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-[3px] rounded-l-lg",
          isDialogue ? "bg-sky-600" : "bg-zinc-400 dark:bg-zinc-600",
        )}
      />
      {editable && (
        <span
          aria-hidden
          onPointerDown={(e) => beginDrag("resize-l", e)}
          className="absolute inset-y-0 left-0 flex w-2 cursor-ew-resize items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span className="h-4 w-0.5 rounded bg-foreground/30" />
        </span>
      )}
      <div className="truncate pl-1 text-[11px] leading-tight">{label}</div>
      <div className="flex items-center gap-1.5 pl-1 text-[9px] text-muted-foreground">
        {isDialogue && cell.cameraState && (
          <span
            className={cn(
              "rounded-full px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide",
              cell.cameraState === "on"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-muted text-muted-foreground",
            )}
          >
            cam {cell.cameraState}
          </span>
        )}
        {castName && <span className="font-medium text-foreground/80">{castName}</span>}
        <span className="font-mono tabular-nums">
          {fmtClock(startSec, true)}–{fmtClock(endSec, true)}
        </span>
      </div>
      {editable && (
        <span
          aria-hidden
          onPointerDown={(e) => beginDrag("resize-r", e)}
          className="absolute inset-y-0 right-0 flex w-2 cursor-ew-resize items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span className="h-4 w-0.5 rounded bg-foreground/30" />
        </span>
      )}
    </div>
  )
}
