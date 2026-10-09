import type { CSSProperties } from "react"
import { CellIssueLines } from "@/components/cell/CellIssueLines"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  healthRibbonColor,
  healthRibbonOpacity,
  type HealthRibbonPoint,
} from "@/lib/health/health-ribbon"
import { formatCellIssueLine, type CellIssueLine } from "@/lib/rules/cell-issue-summary"
import { cn } from "@/lib/utils"
import { useT, type TFunction } from "@/lib/i18n/I18nProvider"

interface HealthRibbonProps {
  point: HealthRibbonPoint
  hasMajorIssue?: boolean
  hasIssue?: boolean
  /** Active checks on this cell. When present, hover names each one. */
  issues?: readonly CellIssueLine[]
  /** Plain hint when the ribbon is flagged with no check to name. */
  issueHint?: string
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

function tooltipContent(
  point: HealthRibbonPoint,
  issueLabel: string,
  issues: readonly CellIssueLine[],
  t: TFunction,
) {
  const raw = point.rawScore === undefined ? undefined : Math.round(point.rawScore)
  const trend = point.smoothedScore === undefined ? undefined : Math.round(point.smoothedScore)

  if (point.stage === "validated") {
    return (
      <div className="space-y-1">
        <p className="font-medium">{t("agentWorkspace.humanValidated")}</p>
        <p>{t("agentWorkspace.validationAuthoritative")}</p>
        {issueDetail(issueLabel, issues)}
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
        {issueDetail(issueLabel, issues)}
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
      {issueDetail(issueLabel, issues)}
    </div>
  )
}

function issueDetail(issueLabel: string, issues: readonly CellIssueLine[]) {
  if (issues.length > 0) return <CellIssueLines lines={issues} />
  if (!issueLabel) return null
  return <p className="font-medium text-amber-600 dark:text-amber-400">{issueLabel}</p>
}

export function HealthRibbon({
  point,
  hasMajorIssue = false,
  hasIssue = false,
  issues = [],
  issueHint,
  className,
  testId = "health-ribbon",
}: HealthRibbonProps) {
  const t = useT()
  const namedIssues = issues.length > 0
    ? issues.map(formatCellIssueLine).join(". ")
    : ""
  const genericLabel = namedIssues || issueHint
    ? ""
    : hasMajorIssue
      ? "Major automatic issue"
      : hasIssue ? "Automatic issue" : ""
  const issueLabel = namedIssues || issueHint || genericLabel
  const label = `${description(point)}${issueLabel ? ` · ${genericLabel ? genericLabel.toLowerCase() : issueLabel}` : ""}`
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
    <AppTooltip content={tooltipContent(point, genericLabel || issueHint || "", issues, t)} side="right" delay={200} className="max-w-xs">
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
