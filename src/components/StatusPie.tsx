import type { CSSProperties, ReactNode } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  STATUS_PIE_CENTER,
  STATUS_PIE_COMPLETE_INNER_C,
  STATUS_PIE_COMPLETE_INNER_R,
  STATUS_PIE_COMPLETE_INNER_STROKE,
  STATUS_PIE_COMPLETE_STROKE,
  STATUS_PIE_OUTER_R,
  STATUS_PIE_OUTER_STROKE,
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
  strokeColor = STATUS_PIE_COMPLETE_STROKE,
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
        "relative flex size-full items-center justify-center",
        interactiveHover && [
          "opacity-90 transition-[opacity,filter] duration-150",
          "group-hover/validate:opacity-100 group-hover/validate:brightness-[0.9]",
          "dark:opacity-80 dark:group-hover/validate:opacity-100 dark:group-hover/validate:brightness-110",
        ],
        className,
      )}
      style={{ color: strokeColor }}
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
        "group-hover/validate:opacity-100 group-hover/validate:brightness-[0.82]",
        "dark:group-hover/validate:opacity-95 dark:group-hover/validate:brightness-[1.18]",
      )
    : ""

  if (tone === "partial") {
    return cn(
      "text-[lch(68%_64_85)] opacity-[0.82]",
      hover,
      "dark:text-[lch(72%_52_85)] dark:opacity-65",
    )
  }
  if (tone === "others") {
    return cn(
      "text-muted-foreground opacity-70",
      hover,
      "dark:opacity-55",
    )
  }
  return cn(
    "text-muted-foreground opacity-40",
    hoverAffordance && "group-hover/validate:opacity-65",
    hover,
    "dark:opacity-35 dark:group-hover/validate:opacity-60",
  )
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
  const hoverShowsComplete = hoverAffordance && hoverP !== null && isFullQuorum(hoverP)
  const hoverShowsWedge =
    hoverAffordance && hoverP !== null && hoverP > 0 && !isFullQuorum(hoverP)
  const box = sizePx + 6
  const tileStyle: CSSProperties = { width: box, height: box }

  if (complete) {
    return (
      <div className={cn("relative shrink-0", className)} style={tileStyle}>
        <CompleteStatusPieGlyph
          sizePx={sizePx}
          strokeColor={stroke ?? STATUS_PIE_COMPLETE_STROKE}
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
  return vs === "full-self" || vs === "full-others" || vs === "full"
}

export function validationPieTone(
  vs: "none" | "self" | "others" | "full" | "full-self" | "full-others" | "empty",
): StatusPieTone {
  if (vs === "self") return "partial"
  if (vs === "others") return "others"
  return "idle"
}
