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
import { getVoiceLibrary, resolveCastVoice } from "@/lib/audio/voices"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { VoicePickerContent } from "@/components/voice/VoiceCombobox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { fmtClock } from "./format"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

/** Round 6 (SUB-38): the source card's voice/character picker wiring. */
export interface TimelineVoiceControl {
  settings: ProjectTtsSettings | undefined
  onAssign(cell: CellData, voiceId: string, opts?: { applyToSpeaker?: boolean }): void
}

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
  /** Round 6: whether this LANE allows retiming at all (the source row never
   *  does — its split is frozen at import). */
  retimable: boolean
  /** Round 6: edge snapping — candidate edge seconds from the lane. */
  snap?: { enabled: boolean; candidates: number[] }
  onSelect(cellId: string): void
  /** Final bounds in seconds, fired once on pointer-up. */
  onRetime(cellId: string, startSec: number, endSec: number): void
  /** AQU-646: navigate playback to this clip on a CLEAN click (a drag that
   *  moved the pointer >3px is a retime, not a seek). Optional — read-only
   *  surfaces select without seeking. */
  onSeek?(cellId: string): void
  /** Round 6 (SUB-38): when set, dialogue cards grow a hover-revealed voice
   *  picker in the bottom-left meta row. */
  voiceControl?: TimelineVoiceControl
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
  onSelect,
  onRetime,
  onSeek,
  voiceControl,
}: TimelineCardProps) {
  // Round 6: a subtitle card on a media cell shows its INDEPENDENT span.
  const laneSpan = variant === "subtitle" ? subtitleSpanSec(cell) : null
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
  const label =
    (isDialogue
      ? cell.transcription || cell.original
      : (cell.medium ?? "text") === "media"
        ? subtitleMirrorText(cell)
        : cell.original) ||
    cell.cellLabel ||
    "—"
  const castName =
    cell.metadata && typeof cell.metadata.cast_name === "string"
      ? (cell.metadata.cast_name as string)
      : null

  // Round 6 (SUB-38): the source card's voice picker — which character reads
  // this line. Hover/selected-revealed to keep cards clean.
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [applyToSpeaker, setApplyToSpeaker] = useState(false)
  const showVoicePicker = isDialogue && voiceControl != null
  const cardVoice = showVoicePicker
    ? resolveCastVoice(voiceControl.settings, cell.id, cell.ttsSettings?.voiceId)
    : null

  return (
    <div
      data-testid={`tl-card-${cell.id}`}
      role="button"
      tabIndex={0}
      onClick={() => {
        onSelect(cell.id)
        if (!movedRef.current) onSeek?.(cell.id)
        movedRef.current = false
      }}
      onPointerDown={(e) => beginDrag("move", e)}
      className={cn(
        "group absolute top-2.5 flex h-[46px] touch-none select-none flex-col justify-center gap-0.5 overflow-hidden rounded-lg border px-2.5 transition-colors",
        isDialogue
          ? "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200"
          : "border-border bg-card text-foreground",
        selected && "z-10 ring-2 ring-sky-500 ring-offset-1 ring-offset-background",
        !selected && "hover:z-10 hover:bg-muted/30",
      )}
      style={{ left: `${left}px`, width: `${width}px` }}
    >
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
              "rounded-full px-1.5 py-px text-[8.5px] font-semibold uppercase tracking-wide",
              cell.cameraState === "on"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                : "bg-muted text-muted-foreground",
            )}
          >
            cam {cell.cameraState}
          </span>
        )}
        {showVoicePicker && cardVoice ? (
          <Popover open={voiceOpen} onOpenChange={setVoiceOpen}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  data-testid={`tl-voice-${cell.id}`}
                  title={castName ? `${castName} — voiced by ${cardVoice.name}` : `Voiced by ${cardVoice.name}`}
                  aria-label={`Voice: ${cardVoice.name}. Choose a voice`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "flex min-w-0 items-center gap-1 rounded-full border border-border/60 bg-background/70 px-1 py-px transition-opacity hover:bg-muted",
                    voiceOpen || selected ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
                  )}
                >
                  <VoiceAvatar voice={cardVoice} size={12} />
                  <span className="max-w-[9ch] truncate font-medium text-foreground/80">
                    {castName ?? cardVoice.name}
                  </span>
                </button>
              }
            />
            <PopoverContent
              align="start"
              side="top"
              className="w-60 p-2"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <VoicePickerContent
                voices={getVoiceLibrary(voiceControl.settings)}
                activeId={cardVoice.id}
                onPick={(voiceId) => {
                  voiceControl.onAssign(cell, voiceId, { applyToSpeaker })
                  setVoiceOpen(false)
                }}
                footer={
                  castName ? (
                    <label className="mt-1.5 flex cursor-pointer items-center gap-2 border-t border-border pt-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        data-testid={`tl-voice-all-${cell.id}`}
                        checked={applyToSpeaker}
                        onChange={(e) => setApplyToSpeaker(e.target.checked)}
                      />
                      Apply to all «{castName}» lines
                    </label>
                  ) : undefined
                }
              />
            </PopoverContent>
          </Popover>
        ) : (
          castName && <span className="font-medium text-foreground/80">{castName}</span>
        )}
        <span className="font-mono tabular-nums">
          {fmtClock(startSec, true)}–{fmtClock(endSec, true)}
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
