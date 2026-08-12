import { AppTooltip } from "@/components/ui/tooltip"
import { fmtLabeledDateTime, fmtShortCalendarDate } from "@/lib/format-date"
import { useI18n } from "@/lib/i18n/I18nProvider"
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
  const { locale } = useI18n()
  if (value == null) return <span className={className}>—</span>
  const t = typeof value === "number" ? value : Date.parse(value)
  if (Number.isNaN(t)) return <span className={className}>—</span>

  return (
    <AppTooltip content={fmtLabeledDateTime(t, label, undefined, locale)}>
      <span className={cn("cursor-default", className)}>{fmtShortCalendarDate(t, undefined, locale)}</span>
    </AppTooltip>
  )
}
