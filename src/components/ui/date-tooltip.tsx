import { AppTooltip } from "@/components/ui/tooltip"
import { fmtLabeledDateTime, fmtShortCalendarDate } from "@/lib/format-date"
import { cn } from "@/lib/utils"

export function DateTooltip({
  value,
  label = "Edited",
  className,
}: {
  value: number | string | null | undefined
  label?: string
  className?: string
}) {
  if (value == null) return <span className={className}>—</span>
  const t = typeof value === "number" ? value : Date.parse(value)
  if (Number.isNaN(t)) return <span className={className}>—</span>

  return (
    <AppTooltip content={fmtLabeledDateTime(t, label)}>
      <span className={cn("cursor-default", className)}>{fmtShortCalendarDate(t)}</span>
    </AppTooltip>
  )
}
