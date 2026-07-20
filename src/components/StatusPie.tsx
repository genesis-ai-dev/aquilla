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

export type StatusPieTone = "idle" | "partial" | "others"

function isFullQuorum(progress: number): boolean {
  return progress >= 1 - 1e-6
}

function CompleteStatusPieGlyph({
  sizePx,
  strokeColor,
  className,
  interactiveHover = false,
}: {
  sizePx: number
  strokeColor?: string
  className?: string
  interactiveHover?: boolean
}) {
  return (
    <div
      className={cn(
        "relative flex size-full items-center justify-center text-green-600 dark:text-green-500",
        interactiveHover && [
          "opacity-90 transition-[opacity,filter] duration-150",
          "group-hover/validate:opacity-100 group-hover/validate:brightness-[0.92]",
          "dark:opacity-90 dark:group-hover/validate:opacity-100 dark:group-hover/validate:brightness-110",
        ],
        className,
      )}
      style={strokeColor ? { color: strokeColor } : undefined}
    >
      <svg
        width={sizePx}
        height={sizePx}
        viewBox={`0 0 ${STATUS_PIE_VIEWBOX} ${STATUS_PIE_VIEWBOX}`}
        fill="none"
        className="workflow-state-icon"
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
        <Check className="size-2 text-white" strokeWidth={3} aria-hidden />
      </div>
    </div>
  )
}

/** Same geometry at rest and hover — only color / opacity shifts. */
function progressPieToneClass(tone: StatusPieTone, hoverAffordance: boolean): string {
  const hover = hoverAffordance
    ? cn(
        "transition-[opacity,filter] duration-150",
        "group-hover/validate:opacity-100 group-hover/validate:brightness-[0.88]",
        "dark:group-hover/validate:opacity-95 dark:group-hover/validate:brightness-[1.12]",
      )
    : ""

  if (tone === "partial") {
    // Linear yellow — you validated, quorum still open
    return cn("opacity-90", hover, "dark:opacity-80")
  }
  if (tone === "others") {
    // Linear steel grey — others validated, you have not
    return cn("opacity-85", hover, "dark:opacity-70")
  }
  // Linear pale grey — empty / idle
  return cn(
    "opacity-55",
    hoverAffordance && "group-hover/validate:opacity-75",
    hover,
    "dark:opacity-45 dark:group-hover/validate:opacity-65",
  )
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
  // (e.g. last click). Already-full grey (full-others) stays grey on hover.
  const hoverShowsComplete =
    !complete && hoverAffordance && hoverP !== null && isFullQuorum(hoverP)
  const hoverShowsWedge =
    hoverAffordance && hoverP !== null && hoverP > 0 && !isFullQuorum(hoverP)
  const box = sizePx + 6
  const tileStyle: CSSProperties = { width: box, height: box }

  if (complete) {
    return (
      <div className={cn("relative shrink-0", className)} style={tileStyle}>
        <CompleteStatusPieGlyph
          sizePx={sizePx}
          strokeColor={stroke}
          interactiveHover
        />
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
          "flex items-center justify-center transition-opacity duration-150",
          hoverShowsComplete && "group-hover/validate:opacity-0",
        )}
      >
        <svg
          width={sizePx}
          height={sizePx}
          viewBox={`0 0 ${STATUS_PIE_VIEWBOX} ${STATUS_PIE_VIEWBOX}`}
          fill="none"
          className={cn(
            "workflow-state-icon",
            progressPieToneClass(tone, hoverAffordance && !hoverShowsComplete),
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
              className={cn(
                hoverShowsWedge && "transition-opacity duration-150 group-hover/validate:opacity-0",
              )}
            />
          ) : null}
          {previewD ? (
            <path
              d={previewD}
              fill="currentColor"
              className="opacity-0 transition-opacity duration-150 group-hover/validate:opacity-100"
            />
          ) : null}
        </svg>
      </div>
      {hoverShowsComplete ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-150",
            "group-hover/validate:opacity-100",
          )}
        >
          <CompleteStatusPieGlyph sizePx={sizePx} />
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

export function validationProgress(
  validatorCount: number,
  requirement: number,
): number {
  if (requirement <= 0) return 0
  return Math.min(1, validatorCount / requirement)
}

/** Quorum fill after the user adds their validation (one click). */
export function validationProgressAfterClick(
  validatorCount: number,
  requirement: number,
): number {
  const req = Math.max(1, requirement)
  return Math.min(1, (validatorCount + 1) / req)
}

/** Quorum fill after the user removes their validation (one click). */
export function validationProgressAfterUnvalidate(
  validatorCount: number,
  requirement: number,
): number {
  const req = Math.max(1, requirement)
  return Math.max(0, (validatorCount - 1) / req)
}

export function isFullValidationStatus(
  vs: "none" | "self" | "others" | "full" | "full-self" | "full-others" | "empty",
): boolean {
  // Purple "done" only when you personally validated and quorum is met.
  return vs === "full-self"
}

export function validationPieTone(
  vs: "none" | "self" | "others" | "full" | "full-self" | "full-others" | "empty",
): StatusPieTone {
  // Colored fill only when you personally validated but quorum isn't met yet.
  // Others-only progress (including full-others) stays grey until full-self.
  if (vs === "self") return "partial"
  if (vs === "others" || vs === "full-others" || vs === "full") return "others"
  return "idle"
}
