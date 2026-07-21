import type { CSSProperties, ReactNode } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  STATUS_PIE_CENTER,
  STATUS_PIE_COMPLETE_INNER_C,
  STATUS_PIE_COMPLETE_INNER_R,
  STATUS_PIE_COMPLETE_INNER_STROKE,
  STATUS_PIE_CYAN,
  STATUS_PIE_IDLE,
  STATUS_PIE_OTHERS,
  STATUS_PIE_OUTER_R,
  STATUS_PIE_OUTER_STROKE,
  STATUS_PIE_PARTIAL,
  STATUS_PIE_VIEWBOX,
  STATUS_PIE_WEDGE_RADIUS,
  statusPieWedgePath,
} from "@/components/status-pie-math"
import type { StatusPieTone } from "@/components/status-pie-validation"

function isFullQuorum(progress: number): boolean {
  return progress >= 1 - 1e-6
}

function CompleteStatusPieGlyph({
  sizePx,
  strokeColor,
  mutedCheck = false,
  className,
}: {
  sizePx: number
  strokeColor?: string
  /** Grey idle preview — softer check; green done keeps white on the disc. */
  mutedCheck?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex size-full items-center justify-center text-green-600 dark:text-green-500",
        className,
      )}
      style={strokeColor ? { color: strokeColor } : undefined}
    >
      <svg
        width={sizePx}
        height={sizePx}
        viewBox={`0 0 ${STATUS_PIE_VIEWBOX} ${STATUS_PIE_VIEWBOX}`}
        fill="none"
        // `size-full` both fills the tile and opts out of Button's
        // `[&_svg:not([class*='size-'])]:size-4` override.
        className="workflow-state-icon size-full"
        aria-hidden
      >
        <circle
          cx={STATUS_PIE_CENTER}
          cy={STATUS_PIE_CENTER}
          r={STATUS_PIE_OUTER_R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STATUS_PIE_OUTER_STROKE}
          strokeDasharray="3.14 0"
          strokeDashoffset={-0.7}
        />
        <circle
          cx={STATUS_PIE_CENTER}
          cy={STATUS_PIE_CENTER}
          r={STATUS_PIE_COMPLETE_INNER_R}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={STATUS_PIE_COMPLETE_INNER_STROKE}
          strokeDasharray={`${STATUS_PIE_COMPLETE_INNER_C} ${STATUS_PIE_COMPLETE_INNER_C * 2}`}
          strokeDashoffset={0}
          transform={`rotate(-90 ${STATUS_PIE_CENTER} ${STATUS_PIE_CENTER})`}
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <Check
          className={cn(
            "size-3",
            mutedCheck ? "text-neutral-600 dark:text-neutral-700" : "text-white",
          )}
          strokeWidth={3}
          aria-hidden
        />
      </div>
    </div>
  )
}

/** Rest opacity only — no filter/brightness (those subpixel-shift the glyph on hover). */
function progressPieToneClass(tone: StatusPieTone): string {
  if (tone === "partial") {
    // Linear yellow — you validated, quorum still open
    return "opacity-90 dark:opacity-80"
  }
  if (tone === "others") {
    // Linear steel grey — others validated, you have not
    return "opacity-85 dark:opacity-70"
  }
  // Linear pale grey — empty / idle
  return "opacity-55 dark:opacity-45"
}

function progressPieToneColor(tone: StatusPieTone, progress: number): string {
  // ~¾ fill uses Linear cyan (palette teal).
  if (progress >= 0.75 - 1e-6 && progress < 1 - 1e-6) {
    return STATUS_PIE_CYAN
  }
  if (tone === "partial") return STATUS_PIE_PARTIAL
  if (tone === "others") return STATUS_PIE_OTHERS
  return STATUS_PIE_IDLE
}

export interface StatusPieProps {
  progress: number
  tone?: StatusPieTone
  complete?: boolean
  /** On hover, show this fill level (next state after validate click). */
  hoverPreviewProgress?: number | null
  stroke?: string
  sizePx?: number
  className?: string
  children?: ReactNode
}

export function StatusPie({
  progress,
  tone = "idle",
  complete = false,
  hoverPreviewProgress = null,
  stroke,
  sizePx = 14,
  className,
  children,
}: StatusPieProps) {
  const p = Math.min(1, Math.max(0, progress))
  const hoverP =
    hoverPreviewProgress === null
      ? null
      : Math.min(1, Math.max(0, hoverPreviewProgress))
  const hoverAffordance =
    hoverP !== null && Math.abs(hoverP - p) > 1e-6
  // Done preview only when progress actually changes into a full quorum
  // (e.g. last click). Preview glyph stays grey — green only once complete.
  const hoverShowsComplete =
    !complete && hoverAffordance && hoverP !== null && isFullQuorum(hoverP)
  const hoverShowsWedge =
    hoverAffordance && hoverP !== null && hoverP > 0 && !isFullQuorum(hoverP)
  // Tile matches the glyph — padding comes from the surrounding button only.
  const box = sizePx
  const tileStyle: CSSProperties = { width: box, height: box }

  if (complete) {
    return (
      <div className={cn("relative shrink-0", className)} style={tileStyle}>
        <CompleteStatusPieGlyph sizePx={sizePx} strokeColor={stroke} />
      </div>
    )
  }

  const wedgeD =
    p > 0
      ? statusPieWedgePath(STATUS_PIE_CENTER, STATUS_PIE_CENTER, STATUS_PIE_WEDGE_RADIUS, p)
      : ""
  const previewD =
    hoverShowsWedge && hoverP !== null
      ? statusPieWedgePath(STATUS_PIE_CENTER, STATUS_PIE_CENTER, STATUS_PIE_WEDGE_RADIUS, hoverP)
      : ""
  const colorProgress =
    hoverShowsWedge && hoverP !== null ? hoverP : p
  const toneColor = stroke ?? progressPieToneColor(tone, colorProgress)

  return (
    <div
      className={cn("relative flex shrink-0 items-center justify-center", className)}
      style={tileStyle}
    >
      <div
        className={cn(
          "flex size-full items-center justify-center",
          hoverShowsComplete && "group-hover/validate:opacity-0",
        )}
      >
        <svg
          width={sizePx}
          height={sizePx}
          viewBox={`0 0 ${STATUS_PIE_VIEWBOX} ${STATUS_PIE_VIEWBOX}`}
          fill="none"
          // `size-full` both fills the tile and opts out of Button's
          // `[&_svg:not([class*='size-'])]:size-4` override.
          className={cn(
            "workflow-state-icon size-full",
            progressPieToneClass(tone),
          )}
          style={{ color: toneColor }}
          aria-hidden
        >
          <circle
            cx={STATUS_PIE_CENTER}
            cy={STATUS_PIE_CENTER}
            r={STATUS_PIE_OUTER_R}
            fill="none"
            stroke="currentColor"
            strokeWidth={STATUS_PIE_OUTER_STROKE}
            strokeDasharray="3.14 0"
            strokeDashoffset={-0.7}
          />
          {wedgeD ? (
            <path
              d={wedgeD}
              fill="currentColor"
              className={cn(hoverShowsWedge && "group-hover/validate:opacity-0")}
            />
          ) : null}
          {previewD ? (
            <path
              d={previewD}
              fill="currentColor"
              className="opacity-0 group-hover/validate:opacity-100"
            />
          ) : null}
        </svg>
      </div>
      {hoverShowsComplete ? (
        <div className="pointer-events-none absolute inset-0 opacity-0 group-hover/validate:opacity-100">
          {/* Grey check until the cell is actually complete — don't flash green
              for an unvalidated hover preview. */}
          <CompleteStatusPieGlyph
            sizePx={sizePx}
            strokeColor={STATUS_PIE_IDLE}
            mutedCheck
            className={progressPieToneClass("idle")}
          />
        </div>
      ) : null}
      {children ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      ) : null}
    </div>
  )
}
