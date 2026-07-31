import type { ComponentType } from "react"
import {
  Archive,
  CircleDashed,
  Clock,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  PROJECT_STATUS_LABEL,
  type ProjectAttentionKind,
  type ProjectAttentionReason,
} from "@/lib/project-status"

type StatusIcon = LucideIcon | ComponentType<{ className?: string }>
type StatusTone = "success" | "danger" | "warning" | "muted"

/** Upward trend from Frame-2.svg — on track. */
function TrendLineIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 9L13.3333 16L8 10.4L4 14.6"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Downward trend from Frame.svg — overdue. */
function TrendLineDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 9L10.6667 16L16 10.4L20 14.6"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const TONE_STYLES: Record<StatusTone, { iconBg: string; icon: string; label: string }> = {
  success: {
    iconBg: "bg-emerald-500/15",
    icon: "text-emerald-600 dark:text-emerald-400",
    label: "text-emerald-600 dark:text-emerald-400",
  },
  danger: {
    iconBg: "bg-destructive/15",
    icon: "text-destructive",
    label: "text-destructive",
  },
  warning: {
    iconBg: "bg-amber-500/15",
    icon: "text-amber-700 dark:text-amber-400",
    label: "text-amber-700 dark:text-amber-400",
  },
  muted: {
    iconBg: "bg-muted",
    icon: "text-muted-foreground",
    label: "text-muted-foreground",
  },
}

const KIND_CONFIG: Record<
  ProjectAttentionKind | "on-track" | "archived",
  { icon: StatusIcon; tone: StatusTone; label: string }
> = {
  overdue: { icon: TrendLineDownIcon, tone: "danger", label: PROJECT_STATUS_LABEL.overdue },
  soon: { icon: Clock, tone: "warning", label: PROJECT_STATUS_LABEL.soon },
  stalled: { icon: CircleDashed, tone: "muted", label: PROJECT_STATUS_LABEL.stalled },
  "on-track": { icon: TrendLineIcon, tone: "success", label: PROJECT_STATUS_LABEL.onTrack },
  archived: { icon: Archive, tone: "muted", label: PROJECT_STATUS_LABEL.archived },
}

/** Linear-style status: tinted icon orb + label (no pill). */
export function LinearStatus({
  icon: Icon,
  label,
  tone,
  className,
  testId,
}: {
  icon: StatusIcon
  label: string
  tone: StatusTone
  className?: string
  testId?: string
}) {
  const styles = TONE_STYLES[tone]
  return (
    <div
      className={cn("flex items-center gap-1.5", className)}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <span className={cn("relative size-4 shrink-0 rounded-lg", styles.iconBg)} aria-hidden>
        <Icon
          className={cn(
            "absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2",
            styles.icon,
          )}
        />
      </span>
      <span className={cn("text-sm", styles.label)}>{label}</span>
    </div>
  )
}

/** Single status by kind (overdue, due soon, stalled, on track, archived). */
export function ProjectStatusChip({
  kind,
  className,
  testId,
}: {
  kind: keyof typeof KIND_CONFIG
  className?: string
  testId?: string
}) {
  const { icon, tone, label } = KIND_CONFIG[kind]
  return <LinearStatus icon={icon} label={label} tone={tone} className={className} testId={testId} />
}

/** One or more attention reasons (overdue / due soon / stalled). */
export function ProjectAttentionStatuses({
  reasons,
  className,
}: {
  reasons: ProjectAttentionReason[]
  className?: string
}) {
  if (reasons.length === 0) return null
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {reasons.map((r) => (
        <ProjectStatusChip key={r.kind} kind={r.kind} />
      ))}
    </div>
  )
}

/** Deadline-only indicators (overdue / due soon) for compact inline rows. */
export function ProjectDeadlineStatuses({
  deadline,
  className,
  testId,
}: {
  deadline: "overdue" | "soon" | "ok" | null
  className?: string
  testId?: string
}) {
  if (deadline === "overdue") return <ProjectStatusChip kind="overdue" className={className} testId={testId} />
  if (deadline === "soon") return <ProjectStatusChip kind="soon" className={className} testId={testId} />
  return null
}

/** Table / overview status cell: archived, attention reasons, or on track. */
export function ProjectStatus({
  archived,
  reasons,
  className,
}: {
  archived: boolean
  reasons: ProjectAttentionReason[]
  className?: string
}) {
  if (archived) return <ProjectStatusChip kind="archived" className={className} />
  if (reasons.length > 0) return <ProjectAttentionStatuses reasons={reasons} className={className} />
  return <ProjectStatusChip kind="on-track" className={className} />
}
