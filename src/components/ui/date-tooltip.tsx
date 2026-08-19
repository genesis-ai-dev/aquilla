import type { ReactNode } from "react"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  fmtDeadlineDate,
  fmtLabeledDeadlineDate,
  fmtLabeledDateTime,
  fmtShortCalendarDate,
} from "@/lib/format-date"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export function DateTooltip({
  value,
  label,
  className,
  children,
  variant = "datetime",
}: {
  value: number | string | Date | null | undefined
  /** Verb/noun prefixed on the hover detail, e.g. "Edited". Defaults to common.date.edited. */
  label?: string
  className?: string
  children?: ReactNode
  /**
   * `deadline` uses calendar-year rules (year shown when the date is not this
   * year) and a date-only hover. Default keeps the last-12-months datetime.
   */
  variant?: "datetime" | "deadline"
}) {
  const { locale, t } = useI18n()
  if (value == null) return null
  const tooltipLabel = label ?? t("common.date.edited")

  if (variant === "deadline") {
    const visible = fmtDeadlineDate(value, undefined, locale)
    if (visible === "—") return null
    return (
      <AppTooltip content={fmtLabeledDeadlineDate(value, tooltipLabel, locale)} side="bottom">
        <span className={cn("cursor-default", className)}>
          {children ?? visible}
        </span>
      </AppTooltip>
    )
  }

  const ts = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value)
  if (Number.isNaN(ts)) return null

  return (
    <AppTooltip content={fmtLabeledDateTime(ts, tooltipLabel, undefined, locale)} side="bottom">
      <span className={cn("cursor-default", className)}>
        {children ?? fmtShortCalendarDate(ts, undefined, locale)}
      </span>
    </AppTooltip>
  )
}
