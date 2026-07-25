// The Target-audio track (rounds 5-7): one chip per media section that has dub
// audio — a recorded take (mic icon) or a generated voice (sparkles). DAW
// model (round 7): chips are CLIP-ZERO ANCHORED — width = the recording's
// trim-aware length, left = anchor + head-trim; the body drag MOVES the clip
// (anchor), the edge handles TRIM it non-destructively (the remaining audio
// never moves in time). An overlong chip draws at full length OVER the
// following chip (earlier chip on top; selected/dragged topmost) — amber when
// running long, red when overlapping the next dub (both will sound). Length
// is never clamped.

import { useRef, useState } from "react"
import { Mic, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { isVisible, secToPx, pxToSec } from "@/lib/timeline/scale"
import {
  targetChipGeom,
  chipOverflowState,
  MIN_TARGET_LEN_SEC,
  type TargetChipGeom,
} from "@/lib/timeline/lane-timing"
import { sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { snapSpan, SNAP_THRESHOLD_PX } from "@/lib/timeline/snap"
import type { CellData } from "@/hooks/useCells"

export interface TargetAudioItem {
  cell: CellData
  kind: "take" | "generated"
  /** The active dub attachment's id (for duration/trim lookup). */
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
  /** Round 6/7: move a chip — the dub's new CLIP-ZERO ANCHOR (file seconds). */
  onRetimeTarget?(cellId: string, anchorSec: number): void
  /** Round 7: trim a chip — the COMPLETE desired trim state (both keys
   *  resolved; undefined clears a key back to the clip edge). */
  onTrimTarget?(cellId: string, audioId: string, trims: { trimStartMs?: number; trimEndMs?: number }): void
  /** Round 8b: corner mic button — opens the recording modal on this cell. */
  onOpenRecording?(cellId: string): void
}

type ChipDragMode = "move" | "resize-l" | "resize-r"

interface ChipGeometry {
  item: TargetAudioItem
  geom: TargetChipGeom
  section: { start: number; end: number }
  resizable: boolean
}

function TargetAudioChip({
  chip,
  nextChipStartSec,
  paintOrder,
  pxPerSec,
  selected,
  editable,
  snap,
  onSelect,
  onSeek,
  onRetimeTarget,
  onTrimTarget,
  onOpenRecording,
}: {
  chip: ChipGeometry
  nextChipStartSec: number | null
  /** Higher paints on top — earlier-start chips cover later ones. */
  paintOrder: number
  pxPerSec: number
  selected: boolean
  editable: boolean
  snap: { enabled: boolean; candidates: number[] }
  onSelect(id: string): void
  onSeek?(id: string): void
  onRetimeTarget?(cellId: string, anchorSec: number): void
  onTrimTarget?(cellId: string, audioId: string, trims: { trimStartMs?: number; trimEndMs?: number }): void
  onOpenRecording?(cellId: string): void
}) {
  const { cell } = chip.item
  const { geom, section } = chip
  const [drag, setDrag] = useState<{ mode: ChipDragMode; dx: number } | null>(null)
  const movedRef = useRef(false)

  // The one span transform shared by preview and commit.
  function proposeSpan(mode: ChipDragMode, dxSec: number): { start: number; end: number } {
    const thresholdSec = SNAP_THRESHOLD_PX / pxPerSec
    if (mode === "move") {
      let start = geom.start + dxSec
      const len = geom.end - geom.start
      if (snap.enabled) {
        // Fallback-width chips sit flush on their own section's candidate
        // edges — snapping only the START edge kills the rubber-band.
        const span = geom.usingFallback ? { start, end: start } : { start, end: start + len }
        start = snapSpan(span, "move", snap.candidates, thresholdSec).start
      }
      // Audible start stays within the section; the epsilon scales with the
      // section so tiny sections can't pin the chip (round-7 fix).
      const maxStart = section.end - Math.min(0.05, Math.max(0.001, (section.end - section.start) / 2))
      start = Math.min(Math.max(start, section.start), Math.max(section.start, maxStart))
      return { start, end: start + len }
    }
    if (mode === "resize-l") {
      let start = geom.start + dxSec
      if (snap.enabled) {
        start = snapSpan({ start, end: geom.end }, "resize-l", snap.candidates, thresholdSec).start
      }
      // trimStart ≥ 0 (start ≥ anchor), audible start in-section, len ≥ min.
      const lo = Math.max(section.start, geom.anchor)
      start = Math.min(Math.max(start, lo), geom.end - MIN_TARGET_LEN_SEC)
      return { start, end: geom.end }
    }
    let end = geom.end + dxSec
    if (snap.enabled) {
      end = snapSpan({ start: geom.start, end }, "resize-r", snap.candidates, thresholdSec).end
    }
    // trimEnd ≤ duration, len ≥ min.
    const hi = geom.durationSec != null ? geom.anchor + geom.durationSec : end
    end = Math.max(Math.min(end, hi), geom.start + MIN_TARGET_LEN_SEC)
    return { start: geom.start, end }
  }

  const span = drag ? proposeSpan(drag.mode, pxToSec(drag.dx, pxPerSec)) : { start: geom.start, end: geom.end }
  const overflow = chipOverflowState(span.end, section.end, nextChipStartSec)
  const canMove = editable && Boolean(onRetimeTarget)
  const canResize =
    editable && Boolean(onTrimTarget) && chip.resizable &&
    secToPx(geom.end - geom.start, pxPerSec) >= 24

  function beginDrag(mode: ChipDragMode, e: React.PointerEvent) {
    if (mode === "move" ? !canMove : !canResize) return
    e.stopPropagation()
    const startX = e.clientX
    try {
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* happy-dom / unsupported — window listeners still work */
    }
    setDrag({ mode, dx: 0 })
    movedRef.current = false
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) movedRef.current = true
      setDrag((d) => (d ? { ...d, dx: ev.clientX - startX } : d))
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setDrag(null)
      const s = proposeSpan(mode, pxToSec(ev.clientX - startX, pxPerSec))
      if (mode === "move") {
        const anchor = s.start - geom.trimStartSec
        if (Math.abs(s.start - geom.start) > 0.0005) onRetimeTarget?.(cell.id, anchor)
        return
      }
      // Resize = trim. Commit the COMPLETE trim state; at-the-edge clears.
      const trimStartMs = Math.round((s.start - geom.anchor) * 1000)
      const trimEndMs = Math.round((s.end - geom.anchor) * 1000)
      const durationMs = geom.durationSec != null ? Math.round(geom.durationSec * 1000) : null
      const changed = Math.abs(s.start - geom.start) > 0.0005 || Math.abs(s.end - geom.end) > 0.0005
      if (!changed) return
      onTrimTarget?.(cell.id, chip.item.audioId, {
        trimStartMs: trimStartMs <= 10 ? undefined : trimStartMs,
        trimEndMs: durationMs != null && trimEndMs >= durationMs - 10 ? undefined : trimEndMs,
      })
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const Icon = chip.item.kind === "take" ? Mic : Sparkles
  const overflowSec = span.end - section.end
  const title =
    overflow === "overlap"
      ? "Overlaps the next dub — both will sound"
      : overflow === "soft"
        ? `Runs ${overflowSec.toFixed(1)}s past the section`
        : chip.item.kind === "take"
          ? "Recorded take"
          : "Generated voice"

  return (
    <button
      type="button"
      data-testid={`tl-target-${cell.id}`}
      data-kind={chip.item.kind}
      data-overflow={overflow}
      title={title}
      onClick={() => {
        onSelect(cell.id)
        if (!movedRef.current) onSeek?.(cell.id)
        movedRef.current = false
      }}
      onPointerDown={(e) => beginDrag("move", e)}
      style={{
        left: `${secToPx(span.start, pxPerSec)}px`,
        width: `${Math.max(10, secToPx(span.end - span.start, pxPerSec))}px`,
        zIndex: (drag ? 2000 : selected ? 1000 : 0) + paintOrder,
      }}
      className={cn(
        "group/chip absolute top-2.5 flex h-[46px] touch-none select-none items-center justify-center overflow-hidden rounded-md border",
        chip.item.kind === "take"
          ? "border-emerald-500/60 bg-emerald-100/80 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
          : "border-violet-500/60 bg-violet-100/80 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300",
        overflow === "soft" && "border-amber-500 ring-1 ring-amber-400/70",
        overflow === "overlap" && "border-red-500 ring-1 ring-red-500/70",
        canMove && "cursor-grab active:cursor-grabbing",
        "hover:brightness-105",
        selected && "ring-2 ring-sky-500",
      )}
    >
      {canResize && (
        <span
          aria-hidden
          data-testid={`tl-target-${cell.id}-handle-l`}
          onPointerDown={(e) => beginDrag("resize-l", e)}
          className="absolute inset-y-0 left-0 flex w-[7px] cursor-col-resize items-center justify-center opacity-0 transition-opacity group-hover/chip:opacity-100"
        >
          <span className="h-4 w-0.5 rounded bg-current/50" />
        </span>
      )}
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {/* Round 8b (Sam): record right from the chip — opens this cell's
          recording modal (takes and all) without a trip to the detail pane.
          Inset from the right edge so it never fights the trim handle. */}
      {editable && onOpenRecording && secToPx(geom.end - geom.start, pxPerSec) >= 28 && (
        <span
          role="button"
          tabIndex={0}
          title="Record audio for this line"
          data-testid={`tl-target-${cell.id}-record`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(cell.id)
            onOpenRecording(cell.id)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              e.stopPropagation()
              onSelect(cell.id)
              onOpenRecording(cell.id)
            }
          }}
          className="absolute right-2 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-background/80 opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:bg-background group-hover/chip:opacity-100 focus-visible:opacity-100"
        >
          <Mic className="h-2.5 w-2.5" />
        </span>
      )}
      {canResize && (
        <span
          aria-hidden
          data-testid={`tl-target-${cell.id}-handle-r`}
          onPointerDown={(e) => beginDrag("resize-r", e)}
          className="absolute inset-y-0 right-0 flex w-[7px] cursor-col-resize items-center justify-center opacity-0 transition-opacity group-hover/chip:opacity-100"
        >
          <span className="h-4 w-0.5 rounded bg-current/50" />
        </span>
      )}
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
  onTrimTarget,
  onOpenRecording,
}: TargetAudioLaneProps) {
  // Resolve every chip first — overflow needs the NEXT chip's start, and
  // snapping needs neighbors' effective edges.
  const chips: ChipGeometry[] = []
  for (const item of items) {
    const att = item.cell.attachments?.[item.audioId]
    const geom = targetChipGeom(item.cell, att)
    const { startTime, endTime } = item.cell
    if (!geom || typeof startTime !== "number" || typeof endTime !== "number") continue
    chips.push({
      item,
      geom,
      section: { start: startTime, end: endTime },
      // No honest length to trim on fallback chips; take-only sections play
      // via the MASTER (which ignores dub trims) — a handle there would lie.
      resizable: !geom.usingFallback && sourceClipAudioForCell(item.cell) != null,
    })
  }

  const candidatesFor = (cellId: string, section: { start: number; end: number }): number[] => {
    if (!snapEnabled) return []
    const out: number[] = [section.start, section.end]
    for (const c of chips) {
      if (c.item.cell.id === cellId) continue
      out.push(c.geom.start, c.geom.end)
    }
    return out
  }

  return (
    // `isolate`: chip z-indexes stack within the lane — never over the playhead.
    <div data-testid="tl-target-lane" className="isolate relative h-[66px] border-b border-border">
      {chips.map((chip, i) =>
        isVisible(chip.geom.start, chip.geom.end, viewStartSec, viewEndSec) ? (
          <TargetAudioChip
            key={chip.item.cell.id}
            chip={chip}
            nextChipStartSec={chips[i + 1]?.geom.start ?? null}
            paintOrder={chips.length - i}
            pxPerSec={pxPerSec}
            selected={selectedId === chip.item.cell.id}
            editable={editable}
            snap={{ enabled: Boolean(snapEnabled), candidates: candidatesFor(chip.item.cell.id, chip.section) }}
            onSelect={onSelect}
            onSeek={onSeek}
            onRetimeTarget={onRetimeTarget}
            onTrimTarget={onTrimTarget}
            onOpenRecording={onOpenRecording}
          />
        ) : null,
      )}
    </div>
  )
}
