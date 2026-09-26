// One take, drawn the way the timeline draws it. (AQU-1210 / AQU-1217, 2026-09-25)
//
// Sam's ruling after the waveform audit: the timeline's take chip does not
// change, and EVERY OTHER place the app draws a take is that same rectangle —
// same filled outline from the same peaks, same 40% ink, same 6px corners and
// 1px border, same way of showing progress (the body darkens up to the play
// point, with the white hairline) and the same 16px corner buttons. Only its
// size changes, and off the timeline its body is neutral grey rather than a
// track's colour.
//
// What it adds that a timeline chip never shows:
//
//   - TRIMMED-OFF AUDIO, FADED. A chip hides the part of a take that does not
//     play; here the whole recording is drawn and the outside is washed out,
//     because these are the places you inspect and trim one take.
//   - EDGE LINES. A trim edge or a split point is a plain, fully opaque 2px
//     line. Where it can be dragged the pointer turns into the left-right
//     resize arrow over it — and nothing else appears (Sam: no grips, no
//     arrows; an earlier semi-transparent handle failed on contrast against
//     grey audio). Read-only edges are the same line in grey.
//
// SVG, not canvas, for the reasons TargetChipWaveform gives: the ink inherits
// the body's colour, the path is rebuilt only when the peaks or the height
// change, and a `d` string is something a happy-dom test can assert.
//
// Purely presentational. The caller owns the audio (peaks, position, play) and
// the rules for moving an edge (see lib/audio/trim-edit).

import { useMemo, useRef } from "react"
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from "react"
import { Play, Square } from "lucide-react"
import { cn } from "@/lib/utils"
import { envelopePathD } from "@/lib/audio/waveform-shape"
import { NEUTRAL_TRACK_VARS, trackChipClass, trackChipPlayingClass } from "@/lib/timeline/track-colors"
import { CHIP_PLAYLINE_CLASS } from "./chip-classes"
import { ChipCornerButton, TakeValidatedBadge } from "./chip-parts"

/** One trim edge or split point. Positions are FRACTIONS of the whole clip. */
export interface WaveformEdge {
  key: string
  at: number
  label: string
  /** Screen-reader text for the value, e.g. "0:00.3". */
  valueText?: string
  /** Draggable? A read-only edge is drawn grey and takes no input. */
  editable: boolean
  /** Pointer drag: the fraction under the pointer. */
  onDrag?: (fraction: number) => void
  /** Arrow keys: -1 / +1, `coarse` with Shift. */
  onNudge?: (direction: -1 | 1, coarse: boolean) => void
  /** The drag (or a key press) is done — persist now. */
  onCommit?: () => void
}

export interface WaveformRectProps {
  /** Peaks for the WHOLE clip, loudest bin at 1. Null or empty draws the body alone. */
  peaks: ArrayLike<number> | null
  /** Outer height in px, border included. */
  height: number
  /** A recorded take or a generated voice: the chip's two body strengths. */
  kind?: "take" | "generated"
  /** The part that plays, as fractions of the whole clip. Outside it is faded. */
  keep?: { start: number; end: number } | null
  /** Playback position as a fraction of the whole clip; drawn only while `playing`. */
  progress?: number | null
  playing?: boolean
  /** Top-left play/stop. Omit to hide the button. */
  onTogglePlay?: () => void
  playLabel?: string
  stopLabel?: string
  /** Replaces the play glyph (a spinner while loading, a cloud, an error). */
  playGlyph?: ReactNode
  playDisabled?: boolean
  /** Top-right mic. */
  onRecord?: () => void
  recordLabel?: string
  recordGlyph?: ReactNode
  /** Bottom-right tick. */
  validation?: "self" | "full" | null
  validationLabel?: string
  /** Click (or drag) along the body to move the playhead. */
  onSeek?: (fraction: number) => void
  seekLabel?: string
  edges?: readonly WaveformEdge[]
  /** Overlaid in the middle: a load button, an error, a "missing" note. */
  status?: ReactNode
  className?: string
  style?: CSSProperties
  testId?: string
  children?: ReactNode
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const pct = (n: number) => `${Math.round(clamp01(n) * 1e6) / 1e4}%`

export function WaveformRect({
  peaks,
  height,
  kind = "take",
  keep = null,
  progress = null,
  playing = false,
  onTogglePlay,
  playLabel = "",
  stopLabel = "",
  playGlyph,
  playDisabled = false,
  onRecord,
  recordLabel = "",
  recordGlyph,
  validation = null,
  validationLabel = "",
  onSeek,
  seekLabel = "",
  edges = [],
  status,
  className,
  style,
  testId,
  children,
}: WaveformRectProps) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  // The drawing box is inside the 1px border, so the path's pixels are exact.
  const innerH = Math.max(0, height - 2)
  const bins = peaks?.length ?? 0
  const d = useMemo(() => (peaks && peaks.length > 0 ? envelopePathD(peaks, innerH) : ""), [peaks, innerH])

  const showProgress = playing && progress != null && Number.isFinite(progress)
  const fracFromX = (clientX: number): number => {
    const el = boxRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp01((clientX - r.left) / Math.max(1, r.width))
  }

  const seekHandlers = onSeek
    ? {
        onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture?.(e.pointerId)
          onSeek(fracFromX(e.clientX))
        },
        onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
          if (e.buttons !== 1) return
          onSeek(fracFromX(e.clientX))
        },
      }
    : {}

  return (
    <div
      ref={boxRef}
      data-testid={testId}
      className={cn(
        // The chip's own body, with its colour ladder spoken in grey.
        "group/wave relative touch-none select-none overflow-hidden rounded-[6px] border",
        trackChipClass(kind),
        showProgress && trackChipPlayingClass(kind),
        className,
      )}
      style={{
        ...NEUTRAL_TRACK_VARS,
        height,
        ...(showProgress ? { "--tl-play-x": pct(progress!) } : {}),
        ...style,
      } as CSSProperties}
    >
      {d && (
        <svg
          aria-hidden
          data-testid={testId ? `${testId}-shape` : undefined}
          className="pointer-events-none absolute inset-0 h-full w-full fill-current opacity-40"
          viewBox={`0 0 ${bins} ${innerH}`}
          preserveAspectRatio="none"
        >
          <path d={d} />
        </svg>
      )}

      {/* The trimmed-off audio: still drawn, washed out. */}
      {keep && keep.start > 0 && (
        <div
          aria-hidden
          data-testid={testId ? `${testId}-fade-start` : undefined}
          className="pointer-events-none absolute inset-y-0 left-0 bg-background/60"
          style={{ width: pct(keep.start) }}
        />
      )}
      {keep && keep.end < 1 && (
        <div
          aria-hidden
          data-testid={testId ? `${testId}-fade-end` : undefined}
          className="pointer-events-none absolute inset-y-0 right-0 bg-background/60"
          style={{ width: pct(1 - keep.end) }}
        />
      )}

      {onSeek && (
        <div
          role="slider"
          aria-label={seekLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clamp01(progress ?? 0) * 100)}
          tabIndex={-1}
          data-testid={testId ? `${testId}-seek` : undefined}
          className="absolute inset-0 cursor-pointer"
          {...seekHandlers}
        />
      )}

      {showProgress && (
        <span
          aria-hidden
          data-testid={testId ? `${testId}-playline` : undefined}
          className={CHIP_PLAYLINE_CLASS}
          style={{ left: pct(progress!), opacity: 1 }}
        />
      )}

      {edges.map((edge) => (
        <EdgeLine key={edge.key} edge={edge} fracFromX={fracFromX} testId={testId ? `${testId}-edge-${edge.key}` : undefined} />
      ))}

      {onTogglePlay && (
        <ChipCornerButton
          side="left"
          label={playing ? stopLabel : playLabel}
          onActivate={onTogglePlay}
          disabled={playDisabled}
          testId={testId ? `${testId}-play` : undefined}
        >
          {playGlyph ?? (playing
            ? <Square className="h-2 w-2 fill-current" />
            : <Play className="h-2.5 w-2.5 fill-current" />)}
        </ChipCornerButton>
      )}
      {onRecord && (
        <ChipCornerButton side="right" label={recordLabel} onActivate={onRecord} testId={testId ? `${testId}-record` : undefined}>
          {recordGlyph}
        </ChipCornerButton>
      )}
      {(validation === "self" || validation === "full") && (
        <TakeValidatedBadge state={validation} label={validationLabel} testId={testId ? `${testId}-validated` : undefined} />
      )}

      {/* The overlay spans the body to centre its message, but only the
          message takes the pointer: the corner buttons and the edge lines stay
          reachable under it (a "Load waveform" take still plays). */}
      {status && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <div className="pointer-events-auto">{status}</div>
        </div>
      )}
      {children}
    </div>
  )
}

function EdgeLine({
  edge,
  fracFromX,
  testId,
}: {
  edge: WaveformEdge
  fracFromX: (clientX: number) => number
  testId?: string
}) {
  const dragging = useRef(false)
  const { editable } = edge

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!editable) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    // Focus follows the grab, so the arrow keys nudge the line you just
    // touched (Sam: "click the line, then the arrow keys").
    e.currentTarget.focus({ preventScroll: true })
    dragging.current = true
    edge.onDrag?.(fracFromX(e.clientX))
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!editable || !dragging.current || e.buttons !== 1) return
    e.stopPropagation()
    edge.onDrag?.(fracFromX(e.clientX))
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    e.stopPropagation()
    edge.onCommit?.()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!editable) return
    // Bare arrows only: Alt+Arrow belongs to the recorder's line navigation,
    // and Space / Escape keep their jobs in whatever dialog this sits in.
    if (e.altKey || e.metaKey || e.ctrlKey) return
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    e.stopPropagation()
    edge.onNudge?.(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey)
    edge.onCommit?.()
  }

  return (
    <div
      role="slider"
      aria-label={edge.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamp01(edge.at) * 100)}
      aria-valuetext={edge.valueText}
      aria-readonly={!editable || undefined}
      tabIndex={editable ? 0 : -1}
      data-testid={testId}
      data-editable={editable ? "true" : "false"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-y-0 z-10 w-2.5 -translate-x-1/2 touch-none outline-none",
        editable ? "cursor-ew-resize focus-visible:bg-foreground/10" : "pointer-events-none",
      )}
      style={{ left: pct(edge.at) }}
    >
      {/* The line itself: 2px, fully opaque. */}
      <div className={cn("mx-auto h-full w-0.5 rounded-[1px]", editable ? "bg-foreground" : "bg-muted-foreground/80")} />
    </div>
  )
}
