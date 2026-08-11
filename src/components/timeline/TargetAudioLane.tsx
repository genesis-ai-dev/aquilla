// The Target-audio track (rounds 5-7): one chip per media section that has dub
// audio — a recorded take (mic icon) or a generated voice (sparkles). DAW
// model (round 7): chips are CLIP-ZERO ANCHORED — width = the recording's
// trim-aware length, left = anchor + head-trim; the body drag MOVES the clip
// (anchor), the edge handles TRIM it non-destructively (the remaining audio
// never moves in time) — amber when running long, red when overlapping a
// neighbour's dub (both will sound). Length is never clamped. At rest the
// chip AT FAULT is the one drawn short (2026-08-08), cut at the edge of the
// neighbour it intrudes on — or, when the two intrude on each other, at the
// source border between them — with an outward chevron on the cut; hover
// restores the true length.

import { useRef, useState } from "react"
import type { ReactNode } from "react"
import { ChevronsLeft, ChevronsRight, CloudUpload, Mic, Sparkles, VolumeX } from "lucide-react"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import { SLOT_GROUP, TimelineSlotButton } from "./TimelineSlotButton"
import { isVisible, secToPx, pxToSec } from "@/lib/timeline/scale"
import {
  targetChipGeom,
  chipOverflowState,
  chipOverlaps,
  chipTrespass,
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
  /** The verse the transport is WAITING ON (queue state "loading") — its chip
   *  shows a small spinner while the readiness gate parks. */
  loadingCellId?: string | null
  /** Cells whose dub audio definitively 404'd — their chips carry a missing
   *  badge (decision 2026-08-05). */
  missingCellIds?: ReadonlySet<string>
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
  /** AQU-646: stretches of film with no cell at all. The mic here creates the
   *  blank line first and then opens the recorder. */
  emptySpans?: readonly { startSec: number; endSec: number }[]
  onAddLineAndRecord?(startSec: number, endSec: number): void
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
  prevChip,
  prevAtFaultTail,
  nextChipStartSec,
  nextAtFaultHead,
  paintOrder,
  audioFirst,
  pxPerSec,
  selected,
  loading,
  missing,
  editable,
  snap,
  onSelect,
  onSeek,
  onRetimeTarget,
  onTrimTarget,
  onOpenRecording,
}: {
  chip: ChipGeometry
  /** The PREVIOUS chip's span — a chip can begin before its own section
   *  (end-based drag bounds), so its head can lie under this neighbour. */
  prevChip: { start: number; end: number; usingFallback: boolean } | null
  /** 2026-08-08: is the PREVIOUS chip itself trespassing forward into this
   *  one? Then its end is no place to yield at — both retreat to the source
   *  border between them instead. */
  prevAtFaultTail: boolean
  nextChipStartSec: number | null
  /** …and the mirror: is the NEXT chip trespassing back into this one? */
  nextAtFaultHead: boolean
  /** Higher paints on top — earlier-start chips cover later ones. */
  paintOrder: number
  /** SUB-53: verses are laid out end to end, so nothing overlaps and nothing
   *  "runs long". */
  audioFirst: boolean
  pxPerSec: number
  selected: boolean
  /** The transport is parked waiting on this verse's audio (slow load). */
  loading: boolean
  /** This chip's dub audio definitively 404'd. */
  missing: boolean
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
      // END-based bounds (meeting 2026-08-05): the chip may slide back into
      // the previous section's space — a long translation borrowing a short
      // neighbour's slack — but its END may not move before its section's
      // START, and its START may not move past the section's END. The epsilon
      // keeps an audible sliver in-section on both edges and scales with the
      // section so tiny sections can't pin the chip (round-7 fix).
      // 2026-08-06 (Sam): the start also may not pass EITHER NEIGHBOUR's
      // start — overlapping a neighbour's tail is a borrowable corner, but
      // leapfrogging or fully covering another chip painted as an unreadable
      // stack and can never be intentional. The rule is symmetric: the floor
      // stops a backward drag at the previous chip's start, the ceiling stops
      // a forward drag at the next chip's start. Hard floor last: audible
      // start ≥ trimStart ⇔ stored anchor ≥ 0, so nothing renders or persists
      // before file time zero.
      const eps = Math.min(0.05, Math.max(0.001, (section.end - section.start) / 2))
      start = Math.min(start, Math.max(section.start, section.end - eps), nextChipStartSec ?? Infinity)
      start = Math.max(start, section.start + eps - len, prevChip?.start ?? -Infinity, geom.trimStartSec)
      return { start, end: start + len }
    }
    if (mode === "resize-l") {
      let start = geom.start + dxSec
      if (snap.enabled) {
        start = snapSpan({ start, end: geom.end }, "resize-l", snap.candidates, thresholdSec).start
      }
      // trimStart ≥ 0 (start ≥ anchor), len ≥ min. No section term: a chip
      // may legitimately begin before its section now (end-based bounds), so
      // the left trim handle follows the CLIP, not the section. (In free
      // timing chipSection.start === geom.anchor, so this is identical there.)
      // The previous chip's start floors it too — un-trimming a head-trimmed
      // clip must not leapfrog the neighbour the move clamp just protected.
      const lo = Math.max(geom.anchor, prevChip?.start ?? -Infinity)
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
  const overflow = audioFirst ? "none" : chipOverflowState(span, section, prevChip, nextChipStartSec)
  const overlaps = audioFirst
    ? { headSec: null, tailSec: null }
    : chipOverlaps(span, prevChip, nextChipStartSec)
  // Blame the trespasser: a warning belongs to THIS chip only for territory
  // it left its section to claim (mirrors the chipOverflowState rule). The
  // number is masked on fallback chips — never derived from a guessed width.
  // The head number depends on the PREVIOUS chip's end too, so it is also
  // masked when THAT width is a guess (starts are always measured, so the
  // tail number needs no such mask).
  const { head: headTrespass, tail: tailTrespass } = audioFirst
    ? { head: false, tail: false }
    : chipTrespass(span, section, prevChip, nextChipStartSec)
  const tailOverlapSec = tailTrespass && !geom.usingFallback ? overlaps.tailSec : null
  const headOverlapSec =
    headTrespass && !geom.usingFallback && !prevChip?.usingFallback ? overlaps.headSec : null
  const canMove = editable && Boolean(onRetimeTarget)
  // SUB-48: a chip that buries a neighbour is PAINTED short so it can never
  // hide one (Sam lost a whole take under one). The logical span is untouched
  // — overflow warnings, trims, snapping and playback all still use the true
  // edges. Hovering (or dragging) reveals the full length, which is exactly
  // when the trim handles appear and must sit on the real edge. Selection
  // deliberately does NOT expand it: selection is sticky, so clicking an
  // overlong chip would re-bury the next one for as long as it stayed
  // selected — the very symptom this fixes.
  //
  // 2026-08-08 (Sam): the chip drawn short is the one AT FAULT, on the side
  // it offends — the same booleans that redden it above, so the paint and the
  // warning can never disagree about who is to blame. Before backdragging
  // existed the cut was always "the left chip yields at the next chip's
  // start", which shortens an innocent neighbour once a chip can be dragged
  // back into it.
  //
  // An offending end yields to the NEIGHBOUR'S OWN EDGE — the least it can
  // give up and still not bury it. When both chips of a pair trespass, each
  // one's edge lies inside the other, so neither is a valid place to stop:
  // they retreat to the source-audio border between them and meet there back
  // to back (»|«). Either way the painted boxes end up disjoint, and an
  // innocent chip always paints its true length.
  // SUB-53: inert in audio-first (verses are laid out end to end).
  const engaged = hovered || drag !== null
  const headCutSec = headTrespass ? (prevAtFaultTail ? section.start : prevChip?.end ?? section.start) : null
  const tailCutSec = tailTrespass ? (nextAtFaultHead ? section.end : nextChipStartSec ?? section.end) : null
  const paintedStart = !engaged && headCutSec != null ? headCutSec : span.start
  const paintedEnd = !engaged && tailCutSec != null ? tailCutSec : span.end
  const truncatedHead = paintedStart > span.start + 0.0005
  const truncatedTail = paintedEnd < span.end - 0.0005
  const truncated = truncatedHead || truncatedTail
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
  const paintedPx = Math.max(10, secToPx(paintedEnd - paintedStart, pxPerSec))
  const fullPx = secToPx(geom.end - geom.start, pxPerSec)
  // The top-left corner is a single PRIORITY slot — one glyph at a time:
  // missing (permanent, actionable) beats loading (transient seconds) beats
  // saving (informational). Same width discipline as before: the glyph needs
  // room in the PAINTED box, and the hover mic button must leave the corner
  // alone whenever any glyph wants it.
  const leftGlyph: "missing" | "loading" | "saving" | null =
    missing ? "missing" : loading ? "loading" : pendingSync ? "saving" : null
  const showLeftGlyph = leftGlyph != null && paintedPx >= 20
  const showRecordButton = editable && Boolean(onOpenRecording) && fullPx >= (leftGlyph != null ? 46 : 28)
  const kindTitle = chip.item.kind === "take" ? "Recorded take" : "Generated voice"
  // SUB-53: audio-first says how the two compare instead of warning. Longer is
  // normal here; shorter is equally unremarkable.
  const lengthNote =
    audioFirst && !geom.usingFallback
      ? `${(span.end - span.start).toFixed(1)}s${chip.ratio != null ? ` — ${chip.ratio.toFixed(1)}× the original` : ""}`
      : null
  // Meeting note (2026-08-05): an overlap warns with the NUMBER, in red — how
  // much of this chip double-sounds — not just prose. Native `title` can't be
  // styled, hence AppTooltip. Secondary notes keep their SUB-48 wording.
  const tipLines: ReactNode[] = []
  if (overflow === "overlap") {
    if (tailTrespass) {
      tipLines.push(
        <div key="tail" className="text-red-600 dark:text-red-400">
          {tailOverlapSec != null && (
            <span
              data-testid={`tl-target-${cell.id}-tip-overlap`}
              className="font-semibold tabular-nums"
            >
              −{tailOverlapSec.toFixed(1)}s{" "}
            </span>
          )}
          <span className="opacity-90">Overlaps the next dub</span>
        </div>,
      )
    }
    if (headTrespass) {
      tipLines.push(
        <div key="head" className="text-red-600 dark:text-red-400">
          {headOverlapSec != null && (
            <span
              data-testid={`tl-target-${cell.id}-tip-overlap-head`}
              className="font-semibold tabular-nums"
            >
              −{headOverlapSec.toFixed(1)}s{" "}
            </span>
          )}
          <span className="opacity-90">Overlaps the previous dub</span>
        </div>,
      )
    }
  } else if (overflow === "soft") {
    tipLines.push(<div key="soft">{`Runs ${overflowSec.toFixed(1)}s past the section`}</div>)
  } else {
    tipLines.push(<div key="kind">{lengthNote ? `${kindTitle} · ${lengthNote}` : kindTitle}</div>)
  }
  // Decision 2026-08-05: a definitively 404'd clip says so, in red.
  if (missing) tipLines.push(<div key="missing" className="font-semibold text-red-600 dark:text-red-400">{MISSING_AUDIO_MESSAGE}</div>)
  // SUB-48: never let a guessed width read as a measured one.
  if (geom.usingFallback) tipLines.push(<div key="fallback" className="text-muted-foreground">Length unknown — re-record or re-upload to fix</div>)
  if (pendingSync) tipLines.push(<div key="saving" className="text-muted-foreground">Saving — kept safe on this device until it syncs</div>)
  // NOTE (2026-08-08): keyed on the CUTS, not on the painted state — hovering
  // is what opens this tooltip and hovering is also what restores full length,
  // so a line keyed on `truncated` could never actually be read.
  if (headCutSec != null || tailCutSec != null) {
    const who =
      headCutSec != null && tailCutSec != null
        ? "the neighbouring dubs stay"
        : headCutSec != null
          ? "the previous dub stays"
          : "the next dub stays"
    tipLines.push(
      <div key="truncated" className="text-muted-foreground">{`Drawn short at rest so ${who} reachable`}</div>,
    )
  }
  const tooltipContent = <div className="flex flex-col gap-0.5">{tipLines}</div>

  return (
    <AppTooltip content={tooltipContent} disabled={drag != null}>
    <button
      type="button"
      data-testid={`tl-target-${cell.id}`}
      // Space after clicking a chip belongs to the TRANSPORT (same opt-in as
      // the timeline cards); the corner record button inside stays native.
      data-spacebar-transport=""
      data-kind={chip.item.kind}
      data-overflow={overflow}
      {...(geom.usingFallback ? { "data-unknown-length": "true" } : {})}
      {...(pendingSync ? { "data-pending-sync": "true" } : {})}
      {...(missing ? { "data-missing": "true" } : {})}
      {...(loading ? { "data-loading": "true" } : {})}
      {...(truncated
        ? { "data-truncated": truncatedHead && truncatedTail ? "both" : truncatedHead ? "start" : "end" }
        : {})}
      // The LOGICAL span, unaffected by any rest-state cut — verification
      // reads these, never the painted box.
      data-span-start={span.start.toFixed(3)}
      data-span-end={span.end.toFixed(3)}
      {...(chip.ratio != null ? { "data-ratio": chip.ratio.toFixed(2) } : {})}
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
        left: `${secToPx(paintedStart, pxPerSec)}px`,
        width: `${paintedPx}px`,
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
        // 2026-08-06 (Sam): overlapping chips are ALWAYS a problem — the
        // whole body goes red, not just the border, so it can't be mistaken
        // for the informational src/tgt end difference.
        overflow === "overlap" &&
          "border-red-500 ring-1 ring-red-500/70 bg-red-100/80 text-red-800 dark:bg-red-950/70 dark:text-red-300",
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
      {/* The corner priority slot: missing badge (decision 2026-08-05) >
          loading spinner (the readiness gate is parked on this verse) >
          SUB-48 saving glyph (still in the outbox — "safe, on its way"). */}
      {showLeftGlyph && (
        <span
          title={
            leftGlyph === "missing"
              ? MISSING_AUDIO_MESSAGE
              : leftGlyph === "loading"
                ? "Loading this clip's audio…"
                : "Saving — kept safe on this device until it syncs"
          }
          data-testid={`tl-target-${cell.id}-${leftGlyph}`}
          className="absolute left-1.5 top-1 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background/85 shadow-sm ring-1 ring-border"
        >
          {leftGlyph === "missing" ? (
            <VolumeX className="h-2.5 w-2.5 text-red-600 dark:text-red-400" />
          ) : leftGlyph === "loading" ? (
            <Spinner className="h-2.5 w-2.5" />
          ) : (
            <CloudUpload className="h-2.5 w-2.5 animate-pulse" />
          )}
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
      {truncatedHead && (
        <span
          aria-hidden
          data-testid={`tl-target-${cell.id}-overflow-head`}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[6px] items-center justify-center",
            overflow === "overlap"
              ? "bg-red-500/25 text-red-700 dark:text-red-300"
              : "bg-amber-400/25 text-amber-700 dark:text-amber-300",
          )}
        >
          <ChevronsLeft className="h-3 w-3" />
        </span>
      )}
      {truncatedTail && (
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
    </AppTooltip>
  )
}

export function TargetAudioLane({
  items,
  layout,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  loadingCellId,
  missingCellIds,
  editable,
  snapEnabled,
  onSelect,
  onSeek,
  onRetimeTarget,
  onTrimTarget,
  onOpenRecording,
  emptyCells,
  emptySpans,
  onAddLineAndRecord,
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

  // 2026-08-08: every chip's fault flags, resolved once. A chip needs its
  // NEIGHBOUR's flag as well as its own: when both trespass on each other,
  // neither's edge is a valid place to stop, so they meet at the source
  // border between them instead of at each other's (invalid) edges.
  const trespass = chips.map((c, i) =>
    chipTrespass(
      { start: c.geom.start, end: c.geom.end },
      c.section,
      i > 0 ? { start: chips[i - 1].geom.start, end: chips[i - 1].geom.end } : null,
      chips[i + 1]?.geom.start ?? null,
    ),
  )

  return (
    // `isolate`: chip z-indexes stack within the lane — never over the playhead.
    <div data-testid="tl-target-lane" className="isolate relative h-[66px] border-b border-border">
      {(emptySpans ?? []).map((span) => {
        const leftPx = secToPx(span.startSec, pxPerSec)
        const widthPx = secToPx(span.endSec - span.startSec, pxPerSec)
        // Same floor as a section's own slot — below this the button has
        // nowhere to sit, so none is offered until you zoom in.
        if (!editable || !onAddLineAndRecord || widthPx < 24) return null
        if (!isVisible(span.startSec, span.endSec, viewStartSec, viewEndSec)) return null
        return (
          <div
            key={`addrec-${span.startSec}`}
            data-testid={`tl-target-add-${span.startSec}`}
            style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
            className={`${SLOT_GROUP} absolute top-2.5 flex h-[46px] items-center justify-center`}
          >
            <TimelineSlotButton
              testId={`tl-target-add-${span.startSec}-record`}
              label="Record over this stretch"
              onClick={() => onAddLineAndRecord(span.startSec, span.endSec)}
            >
              <Mic className="h-3.5 w-3.5" />
            </TimelineSlotButton>
          </div>
        )
      })}
      {emptySlots.map(({ cell, leftPx, widthPx }) => (
        <div
          key={`empty-${cell.id}`}
          data-testid={`tl-target-empty-${cell.id}`}
          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
          className={`${SLOT_GROUP} absolute top-2.5 flex h-[46px] items-center justify-center`}
        >
          <TimelineSlotButton
            testId={`tl-target-empty-${cell.id}-record`}
            label="Record audio for this line"
            onClick={() => {
              onSelect(cell.id)
              onOpenRecording?.(cell.id)
            }}
          >
            <Mic className="h-3.5 w-3.5" />
          </TimelineSlotButton>
        </div>
      ))}
      {chips.map((chip, i) =>
        isVisible(chip.geom.start, chip.geom.end, viewStartSec, viewEndSec) ? (
          <TargetAudioChip
            key={chip.item.cell.id}
            chip={chip}
            prevChip={
              i > 0
                ? {
                    start: chips[i - 1].geom.start,
                    end: chips[i - 1].geom.end,
                    usingFallback: chips[i - 1].geom.usingFallback,
                  }
                : null
            }
            prevAtFaultTail={trespass[i - 1]?.tail ?? false}
            nextChipStartSec={chips[i + 1]?.geom.start ?? null}
            nextAtFaultHead={trespass[i + 1]?.head ?? false}
            paintOrder={chips.length - i}
            audioFirst={Boolean(audioFirst)}
            pxPerSec={pxPerSec}
            selected={selectedId === chip.item.cell.id}
            loading={loadingCellId === chip.item.cell.id}
            missing={missingCellIds?.has(chip.item.cell.id) ?? false}
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
