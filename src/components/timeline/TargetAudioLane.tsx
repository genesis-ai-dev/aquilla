// The Target-audio track (rounds 5-6): one chip per media section that has dub
// audio — a recorded take (mic icon) or a generated voice (sparkles). Round 6
// makes the chips HONEST and MOVABLE (DAW model): width = the recording's
// effective duration (section-width fallback when unknown), left = where the
// dub actually starts (target_start_ms, default section start), draggable
// within its section with edge snapping. A chip running long past its section
// warns amber; one reaching the NEXT section's chip warns red (that dub will
// audibly cut it off). Length is never clamped and never draggable — it IS the
// recording.

import { useRef, useState } from "react"
import { Mic, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { isVisible, secToPx, pxToSec } from "@/lib/timeline/scale"
import { targetChipSpanSec, chipOverflowState } from "@/lib/timeline/lane-timing"
import { snapSpan, SNAP_THRESHOLD_PX } from "@/lib/timeline/snap"
import type { CellData } from "@/hooks/useCells"

export interface TargetAudioItem {
  cell: CellData
  kind: "take" | "generated"
  /** The active dub attachment's id (for duration lookup). */
  audioId: string
}

export interface TargetAudioLaneProps {
  /** Already derived + time-sorted (from the dialogue lane). */
  items: TargetAudioItem[]
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  editable: boolean
  snapEnabled?: boolean
  onSelect(id: string): void
  /** Clean chip click navigates playback to the section (same as a card). */
  onSeek?(id: string): void
  /** Round 6: commit a chip move — the dub's new start (file seconds). */
  onRetimeTarget?(cellId: string, startSec: number): void
}

interface ChipGeometry {
  item: TargetAudioItem
  span: { start: number; end: number; usingFallback: boolean }
  section: { start: number; end: number }
}

function TargetAudioChip({
  geo,
  nextChipStartSec,
  pxPerSec,
  selected,
  editable,
  snap,
  onSelect,
  onSeek,
  onRetimeTarget,
}: {
  geo: ChipGeometry
  nextChipStartSec: number | null
  pxPerSec: number
  selected: boolean
  editable: boolean
  snap: { enabled: boolean; candidates: number[] }
  onSelect(id: string): void
  onSeek?(id: string): void
  onRetimeTarget?(cellId: string, startSec: number): void
}) {
  const { cell } = geo.item
  const lengthSec = geo.span.end - geo.span.start
  const [dragDx, setDragDx] = useState<number | null>(null)
  const movedRef = useRef(false)

  // Move-only: snap the whole span, then clamp the start into the section.
  function proposeStart(dxSec: number): number {
    let s = geo.span.start + dxSec
    if (snap.enabled) {
      s = snapSpan({ start: s, end: s + lengthSec }, "move", snap.candidates, SNAP_THRESHOLD_PX / pxPerSec).start
    }
    const maxStart = Math.max(geo.section.start, geo.section.end - 0.05)
    return Math.min(Math.max(s, geo.section.start), maxStart)
  }

  const startSec = dragDx != null ? proposeStart(pxToSec(dragDx, pxPerSec)) : geo.span.start
  const overflow = chipOverflowState(startSec + lengthSec, geo.section.end, nextChipStartSec)
  const canMove = editable && Boolean(onRetimeTarget)

  function beginDrag(e: React.PointerEvent) {
    if (!canMove) return
    e.stopPropagation()
    const startX = e.clientX
    try {
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* happy-dom / unsupported — window listeners still work */
    }
    setDragDx(0)
    movedRef.current = false
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) movedRef.current = true
      setDragDx(ev.clientX - startX)
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setDragDx(null)
      const s = proposeStart(pxToSec(ev.clientX - startX, pxPerSec))
      if (Math.abs(s - geo.span.start) > 0.0005) onRetimeTarget?.(cell.id, s)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const Icon = geo.item.kind === "take" ? Mic : Sparkles
  const overflowSec = startSec + lengthSec - geo.section.end
  const title =
    overflow === "cutoff"
      ? "Runs into the next section's dub — it will cut this one off"
      : overflow === "soft"
        ? `Runs ${overflowSec.toFixed(1)}s past the section`
        : geo.item.kind === "take"
          ? "Recorded take"
          : "Generated voice"

  return (
    <button
      type="button"
      data-testid={`tl-target-${cell.id}`}
      data-kind={geo.item.kind}
      data-overflow={overflow}
      title={title}
      onClick={() => {
        onSelect(cell.id)
        if (!movedRef.current) onSeek?.(cell.id)
        movedRef.current = false
      }}
      onPointerDown={beginDrag}
      style={{
        left: `${secToPx(startSec, pxPerSec)}px`,
        width: `${Math.max(10, secToPx(lengthSec, pxPerSec))}px`,
      }}
      className={cn(
        "absolute top-2.5 flex h-[46px] touch-none select-none items-center justify-center overflow-hidden rounded-md border",
        geo.item.kind === "take"
          ? "border-emerald-500/60 bg-emerald-100/80 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
          : "border-violet-500/60 bg-violet-100/80 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300",
        overflow === "soft" && "border-amber-500 ring-1 ring-amber-400/70",
        overflow === "cutoff" && "border-red-500 ring-1 ring-red-500/70",
        canMove && "cursor-grab active:cursor-grabbing",
        "hover:brightness-105",
        selected && "ring-2 ring-sky-500",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
    </button>
  )
}

export function TargetAudioLane({
  items,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  editable,
  snapEnabled,
  onSelect,
  onSeek,
  onRetimeTarget,
}: TargetAudioLaneProps) {
  // Resolve every chip's geometry first — overflow needs the NEXT chip's
  // start, and snapping needs neighbors' effective edges.
  const geos: ChipGeometry[] = []
  for (const item of items) {
    const att = item.cell.attachments?.[item.audioId]
    const span = targetChipSpanSec(item.cell, att)
    const { startTime, endTime } = item.cell
    if (!span || typeof startTime !== "number" || typeof endTime !== "number") continue
    geos.push({ item, span, section: { start: startTime, end: endTime } })
  }

  const candidatesFor = (cellId: string, section: { start: number; end: number }): number[] => {
    if (!snapEnabled) return []
    const out: number[] = [section.start, section.end]
    for (const g of geos) {
      if (g.item.cell.id === cellId) continue
      out.push(g.span.start, g.span.end)
    }
    return out
  }

  return (
    <div data-testid="tl-target-lane" className="relative h-[66px] border-b border-border">
      {geos.map((geo, i) =>
        isVisible(geo.span.start, geo.span.end, viewStartSec, viewEndSec) ? (
          <TargetAudioChip
            key={geo.item.cell.id}
            geo={geo}
            nextChipStartSec={geos[i + 1]?.span.start ?? null}
            pxPerSec={pxPerSec}
            selected={selectedId === geo.item.cell.id}
            editable={editable}
            snap={{ enabled: Boolean(snapEnabled), candidates: candidatesFor(geo.item.cell.id, geo.section) }}
            onSelect={onSelect}
            onSeek={onSeek}
            onRetimeTarget={onRetimeTarget}
          />
        ) : null,
      )}
    </div>
  )
}
