import type { CSSProperties } from "react"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  healthRibbonColor,
  healthRibbonOpacity,
  type HealthRibbonPoint,
} from "@/lib/health/health-ribbon"
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

interface HealthRibbonProps {
  point: HealthRibbonPoint
  hasMajorIssue?: boolean
  hasIssue?: boolean
  className?: string
  testId?: string
}

function description(point: HealthRibbonPoint): string {
  const raw = point.rawScore === undefined ? undefined : Math.round(point.rawScore)
  const trend = point.smoothedScore === undefined ? undefined : Math.round(point.smoothedScore)

  if (point.stage === "validated") return "100% assurance · human validated"
  if (point.stage === "automatic") {
    if (raw === undefined) return "Automatic health awaiting evidence"
    return trend === undefined || trend === raw
      ? `Automatic health ${raw}%`
      : `Automatic health ${raw}% · local trend ${trend}%`
  }
  if (raw === undefined) return "Pre-translation source evidence unavailable"
  return trend === undefined || trend === raw
    ? `Pre-translation source evidence ${raw}%`
    : `Pre-translation source evidence ${raw}% · local trend ${trend}%`
}

function tooltipContent(point: HealthRibbonPoint, issueLabel: string, t: TFunction) {
  const raw = point.rawScore === undefined ? undefined : Math.round(point.rawScore)
  const trend = point.smoothedScore === undefined ? undefined : Math.round(point.smoothedScore)

  if (point.stage === "validated") {
    return (
      <div className="space-y-1">
        <p className="font-medium">{t("agentWorkspace.humanValidated")}</p>
        <p>{t("agentWorkspace.validationAuthoritative")}</p>
        {issueLabel && <p className="font-medium text-amber-600 dark:text-amber-400">{issueLabel}</p>}
      </div>
    )
  }

  if (point.stage === "automatic") {
    return (
      <div className="space-y-1">
        <p className="font-medium">
          {raw === undefined
            ? "Automatic estimate pending"
            : `Automatic estimate ${raw}%${trend === undefined || trend === raw ? "" : ` · local trend ${trend}%`}`}
        </p>
        <p>{t("agentWorkspace.automaticHealthHelp")}</p>
        {issueLabel && <p className="font-medium text-amber-600 dark:text-amber-400">{issueLabel}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <p className="font-medium">
        {raw === undefined
          ? "Pre-translation source evidence unavailable"
          : `Source evidence ${raw}%${trend === undefined || trend === raw ? "" : ` · local trend ${trend}%`}`}
      </p>
      <p>{t("agentWorkspace.sourceCoverageHelp")}</p>
      {issueLabel && <p className="font-medium text-amber-600 dark:text-amber-400">{issueLabel}</p>}
    </div>
  )
}

export function HealthRibbon({
  point,
  hasMajorIssue = false,
  hasIssue = false,
  className,
  testId = "health-ribbon",
}: HealthRibbonProps) {
  const t = useT()
  const issueLabel = hasMajorIssue
    ? "Major automatic issue"
    : hasIssue ? "Automatic issue" : ""
  const label = `${description(point)}${issueLabel ? ` · ${issueLabel.toLowerCase()}` : ""}`
  const score = point.smoothedScore
  const opacity = healthRibbonOpacity(point)

  const lineStyle: CSSProperties = score === undefined
    ? {
        backgroundImage: `repeating-linear-gradient(to bottom, rgb(148 163 184 / ${opacity}) 0 4px, transparent 4px 7px)`,
      }
    : {
        backgroundImage: `linear-gradient(to bottom, ${healthRibbonColor(point.topScore ?? score, point.topOpacity ?? opacity)} 0%, ${healthRibbonColor(score, opacity)} 42%, ${healthRibbonColor(score, opacity)} 58%, ${healthRibbonColor(point.bottomScore ?? score, point.bottomOpacity ?? opacity)} 100%)`,
      }

  return (
    <AppTooltip content={tooltipContent(point, issueLabel, t)} side="right" delay={200} className="max-w-xs">
      <span
        data-showcase="cell.health"
        data-testid={testId}
        data-health-stage={point.stage}
        data-health-score={score === undefined ? undefined : Math.round(score)}
        data-health-opacity={opacity.toFixed(2)}
        aria-label={label}
        role="img"
        tabIndex={0}
        className={cn(
          "pointer-events-auto absolute -bottom-2 -top-2 left-0 z-10 w-3 cursor-help focus-visible:outline-none",
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 top-0 w-[2px] transition-opacity duration-500"
          style={lineStyle}
        />
      </span>
    </AppTooltip>
  )
}
