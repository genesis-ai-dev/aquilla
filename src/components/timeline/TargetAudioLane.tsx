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
import { ChevronsRight, CloudUpload, Mic, Sparkles } from "lucide-react"
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
import type { TimelineLayout } from "@/lib/timeline/layout"
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
  /** SUB-53: resolves chip geometry — the frozen file clock in dubbing mode,
   *  the laid-out programme in audio-first. Absent = dubbing. */
  layout?: TimelineLayout
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
  /** SUB-51: timed media sections with NO dub yet. Their empty space in this
   *  row reveals a record button on hover, so starting a line doesn't need a
   *  trip to the detail pane. */
  emptyCells?: CellData[]
}

type ChipDragMode = "move" | "resize-l" | "resize-r"

interface ChipGeometry {
  item: TargetAudioItem
  geom: TargetChipGeom
  section: { start: number; end: number }
  resizable: boolean
  /** SUB-53: how the translation compares to the original — audio-first shows
   *  this instead of the amber/red warnings, because running long is the
   *  expected outcome there, not a defect. Null in dubbing mode. */
  ratio: number | null
}

function TargetAudioChip({
  chip,
  nextChipStartSec,
  paintOrder,
  audioFirst,
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
  /** SUB-53: verses are laid out end to end, so nothing overlaps and nothing
   *  "runs long". */
  audioFirst: boolean
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
  const [hovered, setHovered] = useState(false)
  const movedRef = useRef(false)
  // SUB-48: this clip is saved on this device but its event is still queued.
  const pendingSync = Boolean(cell.attachments?.[chip.item.audioId]?.pendingSync)

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
  // SUB-53: in audio-first every verse owns its own stretch of the track, so
  // there is nothing to run past and nothing to collide with — the warnings
  // would fire on every single line and mean nothing.
  const overflow = audioFirst ? "none" : chipOverflowState(span.end, section.end, nextChipStartSec)
  const canMove = editable && Boolean(onRetimeTarget)
  // SUB-48: a chip that runs past the next dub is PAINTED short so it can
  // never bury its neighbour (Sam lost a whole take under one). The logical
  // span is untouched — overflow warnings, trims, snapping and playback all
  // still use the true end. Hovering (or dragging) reveals the full length,
  // which is exactly when the trim handles appear and must sit on the real
  // edge. Selection deliberately does NOT expand it: selection is sticky, so
  // clicking an overlong chip would re-bury the next one for as long as it
  // stayed selected — the very symptom this fixes.
  const engaged = hovered || drag !== null
  const paintedEnd =
    // `nextChipStartSec > span.start` matters: a chip dragged to sit BEFORE its
    // predecessor would otherwise clamp to its own start and collapse to a
    // sliver. Nothing is buried in that case anyway — it starts first.
    // SUB-53: inert in audio-first (chips never overlap), but harmless.
    !audioFirst && !engaged && nextChipStartSec != null && nextChipStartSec > span.start && span.end > nextChipStartSec
      ? nextChipStartSec
      : span.end
  const truncated = paintedEnd < span.end - 0.0005
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
  const paintedPx = Math.max(10, secToPx(paintedEnd - span.start, pxPerSec))
  const fullPx = secToPx(geom.end - geom.start, pxPerSec)
  // Keep the two corner affordances from landing on top of each other: the
  // saving glyph needs room in the PAINTED box, the mic button appears on
  // hover (when the chip is full width) and must leave the glyph its corner.
  const showSaving = pendingSync && paintedPx >= 20
  const showRecordButton = editable && Boolean(onOpenRecording) && fullPx >= (pendingSync ? 46 : 28)
  const kindTitle = chip.item.kind === "take" ? "Recorded take" : "Generated voice"
  // SUB-53: audio-first says how the two compare instead of warning. Longer is
  // normal here; shorter is equally unremarkable.
  const lengthNote =
    audioFirst && !geom.usingFallback
      ? `${(span.end - span.start).toFixed(1)}s${chip.ratio != null ? ` — ${chip.ratio.toFixed(1)}× the original` : ""}`
      : null
  const title = [
    overflow === "overlap"
      ? "Overlaps the next dub — both will sound"
      : overflow === "soft"
        ? `Runs ${overflowSec.toFixed(1)}s past the section`
        : lengthNote
          ? `${kindTitle} · ${lengthNote}`
          : kindTitle,
    // SUB-48: never let a guessed width read as a measured one.
    geom.usingFallback ? "Length unknown — re-record or re-upload to fix" : null,
    pendingSync ? "Saving — kept safe on this device until it syncs" : null,
    truncated ? "Drawn short so the next dub stays reachable — hover for full length" : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <button
      type="button"
      data-testid={`tl-target-${cell.id}`}
      data-kind={chip.item.kind}
      data-overflow={overflow}
      {...(geom.usingFallback ? { "data-unknown-length": "true" } : {})}
      {...(pendingSync ? { "data-pending-sync": "true" } : {})}
      {...(truncated ? { "data-truncated": "true" } : {})}
      {...(chip.ratio != null ? { "data-ratio": chip.ratio.toFixed(2) } : {})}
      title={title}
      onClick={() => {
        onSelect(cell.id)
        if (!movedRef.current) onSeek?.(cell.id)
        movedRef.current = false
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onPointerDown={(e) => beginDrag("move", e)}
      style={{
        left: `${secToPx(span.start, pxPerSec)}px`,
        width: `${Math.max(10, secToPx(paintedEnd - span.start, pxPerSec))}px`,
        zIndex: (drag ? 2000 : selected || hovered ? 1000 : 0) + paintOrder,
      }}
      className={cn(
        "group/chip absolute top-2.5 flex h-[46px] touch-none select-none items-center justify-center overflow-hidden rounded-md border",
        chip.item.kind === "take"
          ? "border-emerald-500/60 bg-emerald-100/80 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
          : "border-violet-500/60 bg-violet-100/80 text-violet-800 dark:bg-violet-950/70 dark:text-violet-300",
        // An unmeasurable clip spans its section, so say so rather than
        // letting a placeholder width pass for the real thing.
        geom.usingFallback && "border-dashed",
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
      {/* SUB-48: an unmeasurable clip says so instead of quietly borrowing
          the section's width and passing for a measured take. */}
      {geom.usingFallback && (
        <span
          aria-hidden
          data-testid={`tl-target-${cell.id}-unknown-length`}
          className="ml-0.5 shrink-0 text-[10px] font-semibold leading-none opacity-70"
        >
          ?
        </span>
      )}
      {/* SUB-48: still in the outbox — say so, so a queued take reads as
          "safe, on its way" rather than mysteriously present. */}
      {showSaving && (
        <span
          title="Saving — kept safe on this device until it syncs"
          data-testid={`tl-target-${cell.id}-saving`}
          className="absolute left-1.5 top-1 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background/85 shadow-sm ring-1 ring-border"
        >
          <CloudUpload className="h-2.5 w-2.5 animate-pulse" />
        </span>
      )}
      {/* Round 8b (Sam): record right from the chip — opens this cell's
          recording modal (takes and all) without a trip to the detail pane.
          Inset from the right edge so it never fights the trim handle. */}
      {showRecordButton && onOpenRecording && (
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
      {/* SUB-48: the cut edge of a chip drawn short — the audio really does
          keep going past here, and the amber/red ring still tells you it
          collides. Hovering restores the full-length paint. */}
      {truncated && (
        <span
          aria-hidden
          data-testid={`tl-target-${cell.id}-overflow`}
          className={cn(
            "absolute inset-y-0 right-0 flex w-[6px] items-center justify-center",
            overflow === "overlap"
              ? "bg-red-500/25 text-red-700 dark:text-red-300"
              : "bg-amber-400/25 text-amber-700 dark:text-amber-300",
          )}
        >
          <ChevronsRight className="h-3 w-3" />
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
  layout,
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
  emptyCells,
}: TargetAudioLaneProps) {
  const audioFirst = layout?.mode === "audioFirst"
  // Resolve every chip first — overflow needs the NEXT chip's start, and
  // snapping needs neighbors' effective edges.
  const chips: ChipGeometry[] = []
  for (const item of items) {
    const att = item.cell.attachments?.[item.audioId]
    const geom = layout ? layout.targetGeom(item.cell, att) : targetChipGeom(item.cell, att)
    const { startTime, endTime } = item.cell
    if (!geom || typeof startTime !== "number" || typeof endTime !== "number") continue
    const section = layout?.chipSection(item.cell, att) ?? { start: startTime, end: endTime }
    const slot = layout?.programme?.byCellId.get(item.cell.id) ?? null
    chips.push({
      item,
      geom,
      section,
      // No honest length to trim on fallback chips; in DUBBING a take-only
      // section plays via the MASTER (which ignores dub trims), so a handle
      // there would lie. Audio-first plays the dub as its own clip, trims and
      // all, so only the unknown-length case disqualifies it.
      resizable:
        !geom.usingFallback && (audioFirst || sourceClipAudioForCell(item.cell) != null),
      ratio:
        slot && slot.targetLenSec > 0 && slot.sourceLenSec > 0
          ? slot.targetLenSec / slot.sourceLenSec
          : null,
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

  // SUB-51: a record button hiding in the empty space under each dub-free
  // section. Rendered BEFORE the chips and with no z-index, so a real chip —
  // including an overlong neighbour painting across — always wins the pointer.
  const emptySlots =
    editable && onOpenRecording
      ? (emptyCells ?? []).flatMap((cell) => {
          // SUB-53: an un-dubbed verse's slot is just its original's length,
          // so the button sits over exactly where the dub will land.
          const span = layout?.spanFor(cell, "source") ?? null
          const start = span?.start ?? cell.startTime
          const end = span?.end ?? cell.endTime
          if (typeof start !== "number" || typeof end !== "number") return []
          if (!isVisible(start, end, viewStartSec, viewEndSec)) return []
          const widthPx = secToPx(end - start, pxPerSec)
          if (widthPx < 24) return [] // no room for a button worth hitting
          return [{ cell, leftPx: secToPx(start, pxPerSec), widthPx }]
        })
      : []

  return (
    // `isolate`: chip z-indexes stack within the lane — never over the playhead.
    <div data-testid="tl-target-lane" className="isolate relative h-[66px] border-b border-border">
      {emptySlots.map(({ cell, leftPx, widthPx }) => (
        <div
          key={`empty-${cell.id}`}
          data-testid={`tl-target-empty-${cell.id}`}
          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
          className="group/empty absolute top-2.5 flex h-[46px] items-center justify-center"
        >
          <button
            type="button"
            title="Record audio for this line"
            data-testid={`tl-target-empty-${cell.id}-record`}
            aria-label="Record audio for this line"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(cell.id)
              onOpenRecording?.(cell.id)
            }}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-background/90 opacity-0 shadow-sm ring-1 ring-border transition-opacity hover:bg-background group-hover/empty:opacity-100 focus-visible:opacity-100"
          >
            <Mic className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {chips.map((chip, i) =>
        isVisible(chip.geom.start, chip.geom.end, viewStartSec, viewEndSec) ? (
          <TargetAudioChip
            key={chip.item.cell.id}
            chip={chip}
            nextChipStartSec={chips[i + 1]?.geom.start ?? null}
            paintOrder={chips.length - i}
            audioFirst={Boolean(audioFirst)}
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
