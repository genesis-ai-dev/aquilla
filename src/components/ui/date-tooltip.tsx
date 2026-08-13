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
  if (value == null) return null
  const t = typeof value === "number" ? value : Date.parse(value)
  if (Number.isNaN(t)) return null

  return (
    <AppTooltip content={fmtLabeledDateTime(t, label)} side="bottom">
      <span className={cn("cursor-default", className)}>{fmtShortCalendarDate(t)}</span>
    </AppTooltip>
  )
}
