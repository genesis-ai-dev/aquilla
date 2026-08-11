// A single timeline clip. Positioned by time; drag the body to move and drag
// the edge grips to stretch start/end. Commits once on pointer-up via onRetime
// (seconds); the parent converts to ms and emits. Hand-rolled with
// window-level pointer listeners (robust when the pointer leaves the card, and
// testable under happy-dom). Read-only files disable drag but still select.
//
// Round 6 (SUB-36): the SOURCE row is frozen (`retimable=false` — no grips,
// no move); a subtitle card on a MEDIA cell renders/edits its independent
// subtitle span (metadata) rather than the source split; drags snap to
// neighboring edges when snapping is on — preview and commit run through the
// same seconds-domain transform, so what you see is what lands.

import { useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { secToPx, pxToSec, clampRange } from "@/lib/timeline/scale"
import { subtitleMirrorText } from "@/lib/timeline/lanes"
import { subtitleSpanSec } from "@/lib/timeline/lane-timing"
import { snapSpan, SNAP_THRESHOLD_PX } from "@/lib/timeline/snap"
import { fmtClock } from "./format"
import { formatVttTime } from "@/lib/video/vtt-generator"
import type { CellData } from "@/hooks/useCells"

const MIN_DUR_SEC = 0.2

type DragMode = "move" | "resize-l" | "resize-r"

/** SUB-11: millisecond clock for the live drag readout — `formatVttTime`
 * (HH:MM:SS.mmm) with a zero hours field trimmed for width. */
function fmtDragTime(sec: number): string {
  const t = formatVttTime(Math.max(0, sec))
  return t.startsWith("00:") ? t.slice(3) : t
}

export interface TimelineCardProps {
  cell: CellData
  pxPerSec: number
  /** Time (s) at the left edge of the track; usually 0. */
  laneStartSec: number
  variant: "subtitle" | "dialogue"
  selected: boolean
  editable: boolean
  /** Round 6: whether this LANE allows retiming at all (the source row never
   *  does — its split is frozen at import). */
  retimable: boolean
  /** Round 6: edge snapping — candidate edge seconds from the lane. */
  snap?: { enabled: boolean; candidates: number[] }
  /** SUB-53: where this card sits, resolved by the lane's layout. Absent falls
   *  back to the pre-SUB-53 computation (the dubbing answer). */
  span?: { start: number; end: number }
  onSelect(cellId: string): void
  /** Final bounds in seconds, fired once on pointer-up. */
  onRetime(cellId: string, startSec: number, endSec: number): void
  /** AQU-646: navigate playback to this clip on a CLEAN click (a drag that
   *  moved the pointer >3px is a retime, not a seek). Optional — read-only
   *  surfaces select without seeking. */
  onSeek?(cellId: string): void
}

export function TimelineCard({
  cell,
  pxPerSec,
  laneStartSec,
  variant,
  selected,
  editable,
  retimable,
  snap,
  span,
  onSelect,
  onRetime,
  onSeek,
}: TimelineCardProps) {
  // Round 6: a subtitle card on a media cell shows its INDEPENDENT span.
  const laneSpan = span ?? (variant === "subtitle" ? subtitleSpanSec(cell) : null)
  const startSec = laneSpan?.start ?? cell.startTime ?? 0
  const endSec = laneSpan?.end ?? cell.endTime ?? startSec + MIN_DUR_SEC
  const [drag, setDrag] = useState<{ mode: DragMode; dx: number } | null>(null)
  // Set while a drag gesture moved the pointer — the click event that closes a
  // drag must not also yank playback to the clip's start.
  const movedRef = useRef(false)
  const canRetime = editable && retimable

  // The one span transform shared by drag PREVIEW and COMMIT (snap included).
  function proposeSpan(mode: DragMode, dxSec: number): { start: number; end: number } {
    let ns = startSec
    let ne = endSec
    if (mode === "move") {
      ns += dxSec
      ne += dxSec
    } else if (mode === "resize-l") ns += dxSec
    else ne += dxSec
    if (snap?.enabled) {
      const snapped = snapSpan({ start: ns, end: ne }, mode, snap.candidates, SNAP_THRESHOLD_PX / pxPerSec)
      return { start: snapped.start, end: snapped.end }
    }
    return { start: ns, end: ne }
  }

  // Live preview geometry while dragging; committed values come from props.
  let left = secToPx(startSec - laneStartSec, pxPerSec)
  let width = secToPx(endSec - startSec, pxPerSec)
  if (drag) {
    const s = proposeSpan(drag.mode, pxToSec(drag.dx, pxPerSec))
    left = secToPx(s.start - laneStartSec, pxPerSec)
    width = secToPx(s.end - s.start, pxPerSec)
  }
  width = Math.max(width, secToPx(MIN_DUR_SEC, pxPerSec))

  // SUB-11: live preview TIMES during drag — the same per-mode + clampRange
  // math `onUp` commits, so the readout always shows exactly what release
  // would produce. `previewStart/End` equal the committed props when idle.
  let previewStart = startSec
  let previewEnd = endSec
  if (drag) {
    const dSec = pxToSec(drag.dx, pxPerSec)
    let ns = startSec
    let ne = endSec
    if (drag.mode === "move") {
      ns = startSec + dSec
      ne = endSec + dSec
    } else if (drag.mode === "resize-l") ns = startSec + dSec
    else ne = endSec + dSec
    const clamped = clampRange(ns, ne, MIN_DUR_SEC)
    previewStart = clamped.startSec
    previewEnd = clamped.endSec
  }
  const dragDeltaSec = drag
    ? drag.mode === "resize-r"
      ? previewEnd - endSec
      : previewStart - startSec
    : 0

  function beginDrag(mode: DragMode, e: React.PointerEvent) {
    if (!canRetime) return
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
      const clamped = clampRange(s.start, s.end, MIN_DUR_SEC)
      if (clamped.startSec !== startSec || clamped.endSec !== endSec) {
        onRetime(cell.id, clamped.startSec, clamped.endSec)
      }
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const isDialogue = variant === "dialogue"
  // AQU-646: a media cell rendered in the SUBTITLE lane is the mirror card of
  // an audio block — it shows the translation once translated, else the
  // transcript (never the filename-ish `original`).
  const labelText =
    isDialogue
      ? cell.transcription || cell.original
      : (cell.medium ?? "text") === "media"
        ? subtitleMirrorText(cell)
        : cell.original
  // AQU-646: a cell that exists but has nothing written in it yet. Dotted means
  // a different thing in each track — on the SUBTITLE track it is exactly this:
  // the cell is real, the words are not here yet. (Source audio uses dotted for
  // the opposite, audio with no cell; the target track only ever uses it to say
  // something is wrong.) A blank chip carries no placeholder text either — an
  // em dash would read as content.
  const blank = !labelText?.trim() && !cell.translated?.trim()
  // The em-dash placeholder reads as content. A line nobody has written yet
  // shows its timecode and nothing else, in either track.
  const label = blank ? "" : labelText || cell.cellLabel || "—"
  const castName =
    cell.metadata && typeof cell.metadata.cast_name === "string"
      ? (cell.metadata.cast_name as string)
      : null

  return (
    <div
      data-testid={`tl-card-${cell.id}`}
      role="button"
      tabIndex={0}
      // Space on a just-clicked card toggles the transport (playback-keys
      // honors this opt-in) — a card's activation is selection, already done.
      data-spacebar-transport=""
      onClick={() => {
        onSelect(cell.id)
        if (!movedRef.current) onSeek?.(cell.id)
        movedRef.current = false
      }}
      onPointerDown={(e) => beginDrag("move", e)}
      className={cn(
        "group absolute top-2.5 flex h-[46px] touch-none select-none flex-col justify-center gap-0.5 rounded-lg border px-2.5 transition-colors",
        // SUB-11: the drag chip renders above the card bounds, so overflow can't
        // be hidden mid-drag; inner text stays contained by its own `truncate`s.
        drag ? "z-20 overflow-visible" : "overflow-hidden",
        isDialogue
          ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200"
          : "border-border bg-card text-foreground",
        // Dotted means a different thing in each track (Sam, 2026-08-11). In
        // SUBTITLES it is this: the cell is real, the words are not here yet.
        // The Source track reserves it for the opposite — audio with no cell —
        // so a blank cell there is an ordinary chip with nothing written on it.
        blank && !isDialogue && "border-dashed bg-transparent",
        selected && "z-10 ring-2 ring-sky-500 ring-offset-1 ring-offset-background",
        !selected && !drag && "hover:z-10 hover:bg-muted/30",
      )}
      style={{ left: `${left}px`, width: `${width}px` }}
    >
      {drag && (
        // SUB-11: live millisecond readout while dragging — anchored to the
        // edge being manipulated; shows the exact value release would commit.
        <span
          data-testid="tl-drag-chip"
          className={cn(
            "pointer-events-none absolute -top-6 z-30 rounded bg-foreground px-1.5 py-0.5 font-mono text-[10px] tabular-nums whitespace-nowrap text-background shadow",
            drag.mode === "resize-r" ? "right-0" : "left-0",
          )}
        >
          {drag.mode === "move"
            ? `${fmtDragTime(previewStart)}–${fmtDragTime(previewEnd)}`
            : fmtDragTime(drag.mode === "resize-l" ? previewStart : previewEnd)}
          {" "}({dragDeltaSec >= 0 ? "+" : "−"}{Math.abs(dragDeltaSec).toFixed(2)}s)
        </span>
      )}
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-[3px] rounded-l-lg",
          isDialogue ? "bg-sky-600" : "bg-zinc-400 dark:bg-zinc-600",
        )}
      />
      {canRetime && (
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
              "rounded-md px-1.5 py-px text-[8.5px] font-semibold",
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
          {/* SUB-11: while dragging, show the live preview bounds (ms) rather
              than the stale committed props. */}
          {drag
            ? `${fmtDragTime(previewStart)}–${fmtDragTime(previewEnd)}`
            : `${fmtClock(startSec, true)}–${fmtClock(endSec, true)}`}
        </span>
      </div>
      {canRetime && (
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
