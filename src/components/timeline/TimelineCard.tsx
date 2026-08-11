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
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { secToPx, pxToSec, clampRange, chipRadiusPx } from "@/lib/timeline/scale"
import { subtitleMirrorText } from "@/lib/timeline/lanes"
import { subtitleSpanSec } from "@/lib/timeline/lane-timing"
import { snapSpan, SNAP_THRESHOLD_PX } from "@/lib/timeline/snap"
import { fmtClock } from "./format"
import { formatVttTime } from "@/lib/video/vtt-generator"
import type { CellData } from "@/hooks/useCells"

const MIN_DUR_SEC = 0.2

/**
 * Below these widths a chip stops rendering text. (AQU-646 round 9)
 *
 * Fully zoomed out a chip is 10–20px wide, and it was still rendering its label
 * AND its clock range: every chip a column of one or two truncated glyphs, and
 * the source band's time ranges reading as if they bled across their
 * neighbours. Sam's word for the result was "rendering issues", and he was
 * being generous.
 *
 * Two thresholds because the two texts fail at different widths. The clock line
 * ("0:41.8–0:43.0") needs ~85px and has no `truncate`, so it is the first to
 * turn to mush; the label has `truncate` and survives down to about 40px, below
 * which even an ellipsis is noise. Under 40 the card is what it should have
 * been all along at that zoom: a plain block.
 */
export const MIN_CARD_META_PX = 72
const MIN_CARD_TEXT_PX = 40

/**
 * The colored stripe down a chip's left edge. A shared constant because the
 * left resize grip has to start where it ENDS — see below.
 */
const ACCENT_BAR_PX = 3

/**
 * Below this a chip offers no resize grips.
 *
 * The arithmetic: each grip is an 8px target, and the left one starts after the
 * accent bar, so the two together claim 3 + 8 + 8 = 19px. Under about 28px
 * there is no body left between them to grab for a MOVE, and the grips
 * themselves start to overlap — you would be aiming at a target smaller than
 * the pointer. A chip this narrow is also a poor thing to resize by hand: at
 * the widest zoom-out a single pixel is an eighth of a second. Move it, or zoom
 * in to trim it.
 */
const MIN_CARD_GRIP_PX = 28

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
  /** AQU-646 round 8: hard walls this card may not cross — the neighbouring
   *  cues' edges. Absent = unbounded, which is every lane but the VTT-plus-
   *  footage Subtitles track. Subtitle timing IS the cell's timing, so unlike a
   *  dub take it does not get to be approximate: no crossing, no overlapping. */
  bounds?: { minStartSec: number; maxEndSec: number }
  onSelect(cellId: string): void
  /** Final bounds in seconds, fired once on pointer-up. */
  onRetime(cellId: string, startSec: number, endSec: number): void
  /** AQU-646: navigate playback to this clip on a CLEAN click (a drag that
   *  moved the pointer >3px is a retime, not a seek). Optional — read-only
   *  surfaces select without seeking. */
  onSeek?(cellId: string): void
  /** AQU-646: offered only on a line a person added that is still empty —
   *  the workspace decides, this just draws the control. */
  onRemove?(cellId: string): void
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
  bounds,
  onSelect,
  onRetime,
  onSeek,
  onRemove,
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

  // The one span transform shared by drag PREVIEW, READOUT and COMMIT: the
  // per-mode delta, then snapping, then the neighbour walls, then the minimum
  // length. Everything the user can see about a drag comes through here, so the
  // drawn box, the millisecond readout and the value that lands cannot disagree.
  function proposeSpan(mode: DragMode, dxSec: number): { startSec: number; endSec: number } {
    let ns = startSec
    let ne = endSec
    if (mode === "move") {
      ns += dxSec
      ne += dxSec
    } else if (mode === "resize-l") ns += dxSec
    else ne += dxSec
    if (snap?.enabled) {
      const snapped = snapSpan({ start: ns, end: ne }, mode, snap.candidates, SNAP_THRESHOLD_PX / pxPerSec)
      ns = snapped.start
      ne = snapped.end
    }
    // AFTER snapping, deliberately: a neighbour's edge is a legal snap target
    // AND a wall, so a candidate that would land the card past a wall has to
    // lose to the wall. Clamping first would let the snap step step back over it.
    if (bounds) {
      const { minStartSec: lo, maxEndSec: hi } = bounds
      if (mode === "move") {
        // Slide, never squeeze: a move keeps its length and stops at the wall.
        const len = ne - ns
        ns = Math.min(Math.max(ns, lo), Math.max(lo, hi - len))
        ne = ns + len
      } else if (mode === "resize-l") {
        ns = Math.min(Math.max(ns, lo), ne - MIN_DUR_SEC)
      } else {
        ne = Math.max(Math.min(ne, hi), ns + MIN_DUR_SEC)
      }
    }
    return clampRange(ns, ne, MIN_DUR_SEC)
  }

  // Computed ONCE per render while a drag is live. Before round 8 the box read
  // a snapped-but-unclamped span while the readout re-derived an unsnapped-but-
  // clamped one — despite a comment claiming they matched — so with snapping on
  // the number under the cursor disagreed with the box being drawn.
  const dragged = drag ? proposeSpan(drag.mode, pxToSec(drag.dx, pxPerSec)) : null

  const left = secToPx((dragged?.startSec ?? startSec) - laneStartSec, pxPerSec)
  const width = Math.max(
    secToPx((dragged?.endSec ?? endSec) - (dragged?.startSec ?? startSec), pxPerSec),
    secToPx(MIN_DUR_SEC, pxPerSec),
  )

  // Round 9b: the corner shrinks with the chip. A constant 8px radius on a 26px
  // chip is a third of its width, and against a dashed neighbour that reads as
  // two shapes interlocking. See chipRadiusPx.
  const radiusPx = chipRadiusPx(width)

  // Round 9: what there is room to SAY at this width. A dragging card always
  // shows its text — you are looking straight at it, and its own drag chip is
  // the readout that matters.
  const showsText = width >= MIN_CARD_TEXT_PX || Boolean(drag)
  const showsMeta = width >= MIN_CARD_META_PX || Boolean(drag)
  // Grips stay while a drag is live, or a resize would cancel itself the moment
  // it dragged the chip below the threshold.
  const showsGrips = canRetime && (width >= MIN_CARD_GRIP_PX || Boolean(drag))

  // SUB-11: live preview TIMES during drag; equal to the committed props idle.
  const previewStart = dragged?.startSec ?? startSec
  const previewEnd = dragged?.endSec ?? endSec
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
      if (s.startSec !== startSec || s.endSec !== endSec) {
        onRetime(cell.id, s.startSec, s.endSec)
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
        "group absolute top-2.5 flex h-[46px] touch-none select-none flex-col justify-center gap-0.5 border transition-colors",
        // The padding comes off before the chip gets narrow enough for it to
        // LIE ABOUT THE CHIP'S WIDTH. px-2.5 plus two 1px borders is 22px of
        // chrome, and under border-box that is a hard floor on the rendered
        // box — so a cue shorter than 22px was drawn 22px wide and spilled
        // into its neighbour. That is the "two real chips overlap" Sam saw:
        // the chip was positioned correctly and simply drawn too big. Keyed on
        // width alone rather than `showsText`, so a chip being dragged cannot
        // re-inflate itself while you are placing it.
        width >= MIN_CARD_TEXT_PX ? "px-2.5" : "px-0",
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
      style={{ left: `${left}px`, width: `${width}px`, borderRadius: `${radiusPx}px` }}
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
          "absolute inset-y-0 left-0",
          isDialogue ? "bg-sky-600" : "bg-zinc-400 dark:bg-zinc-600",
        )}
        // Follows the card's own corner or it pokes out of a sharpened one.
        style={{
          width: `${ACCENT_BAR_PX}px`,
          borderTopLeftRadius: `${radiusPx}px`,
          borderBottomLeftRadius: `${radiusPx}px`,
        }}
      />
      {onRemove && showsText && (
        // Same manners as the slot buttons: nothing at rest, faint on the
        // chip's hover. It must not reach the card's own click, which would
        // select and seek on the way out.
        <button
          type="button"
          title="Remove this line"
          aria-label="Remove this line"
          data-testid={`tl-card-${cell.id}-remove`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove(cell.id)
          }}
          className="absolute right-1 top-1 z-20 flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-70 focus-visible:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      {showsGrips && (
        <span
          aria-hidden
          onPointerDown={(e) => beginDrag("resize-l", e)}
          className="absolute inset-y-0 flex w-2 cursor-ew-resize items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
          // Starts where the accent bar ENDS. At left-0 its line landed flush
          // against the stripe, and the two read as one thick left edge — which
          // is what made the handle look mis-set to the left next to a right
          // grip that has clear space on both sides (Sam, 2026-08-11).
          style={{ left: `${ACCENT_BAR_PX}px` }}
        >
          <span className="h-4 w-0.5 rounded bg-foreground/30" />
        </span>
      )}
      {showsText && <div className="truncate pl-1 text-[11px] leading-tight">{label}</div>}
      {showsMeta && (
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
      )}
      {showsGrips && (
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
