import type { ReactNode } from "react"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  fmtDeadlineDate,
  fmtLabeledDeadlineDate,
  fmtLabeledDateTime,
  fmtShortCalendarDate,
} from "@/lib/format-date"
import { formatDateTime } from "@/lib/i18n/format"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export function DateTooltip({
  value,
  label,
  className,
  children,
  variant = "datetime",
  editedAt,
  editedNotice,
  side = "bottom",
}: {
  value: number | string | Date | null | undefined
  /** Verb/noun prefixed on the hover detail, e.g. "Edited". Defaults to common.date.edited. */
  label?: string
  className?: string
  children?: ReactNode
  /**
   * `deadline` uses calendar-year rules (year shown when the date is not this
   * year) and a date-only hover. `ago` shows the compact relative form
   * ("10d ago") and keeps the full datetime on hover. Default keeps the
   * last-12-months datetime.
   */
  variant?: "datetime" | "deadline" | "ago"
  /** Later timestamp. When it differs from `value`, the hover lists both. */
  editedAt?: number | string | Date | null
  /** Visible mark after the time, e.g. "(edited)", shown only when `editedAt` differs. */
  editedNotice?: string
  /** Which side of the timestamp the hover detail opens on. */
  side?: "top" | "bottom" | "left" | "right"
}) {
  const { locale, t } = useI18n()
  if (value == null) return null
  const tooltipLabel = label ?? t("common.date.edited")

  if (variant === "deadline") {
    const visible = fmtDeadlineDate(value, undefined, locale)
    if (visible === "—") return null
    return (
      <AppTooltip content={fmtLabeledDeadlineDate(value, tooltipLabel, locale)} side={side}>
        <span className={cn("cursor-default transition-colors hover:text-foreground", className)}>
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

  const visible = variant === "ago" ? compactAgo(ts, t) : fmtShortCalendarDate(ts, undefined, locale)
  const editedTs = timestampOf(editedAt)
  const wasEdited = editedTs != null && editedTs !== ts

  return (
    <AppTooltip
      content={
        wasEdited
          ? <EditedTooltip created={ts} edited={editedTs} locale={locale} t={t} />
          : fmtLabeledDateTime(ts, tooltipLabel, undefined, locale)
      }
      side={side}
    >
      <span className={cn("cursor-default transition-colors hover:text-foreground", className)}>
        {children ?? visible}
        {wasEdited && editedNotice ? <span> {editedNotice}</span> : null}
      </span>
    </AppTooltip>
  )
}

const EDITED_DETAIL_OPTS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
}

function EditedTooltip({
  created,
  edited,
  locale,
  t,
}: {
  created: number
  edited: number
  locale: string
  t: ReturnType<typeof useI18n>["t"]
}) {
  return (
    <span className="flex flex-col">
      <span>{t("common.date.created")}: {formatDateTime(created, locale, EDITED_DETAIL_OPTS)}</span>
      <span>{t("common.date.edited")}: {formatDateTime(edited, locale, EDITED_DETAIL_OPTS)}</span>
    </span>
  )
}

function timestampOf(value: number | string | Date | null | undefined): number | null {
  if (value == null) return null
  const ts = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value)
  return Number.isNaN(ts) ? null : ts
}

/** Compact relative time, the same labels as the outbox ("10d ago"). */
function compactAgo(ts: number, t: ReturnType<typeof useI18n>["t"]): string {
  const delta = Math.max(0, Date.now() - ts)
  if (delta < 5_000) return t("nav.outbox.timeJustNow")
  const sec = Math.round(delta / 1000)
  if (sec < 60) return t("nav.outbox.timeSecondsAgo", { sec })
  const min = Math.round(sec / 60)
  if (min < 60) return t("nav.outbox.timeMinutesAgo", { min })
  const hr = Math.round(min / 60)
  if (hr < 24) return t("nav.outbox.timeHoursAgo", { hr })
  const d = Math.round(hr / 24)
  return t("nav.outbox.timeDaysAgo", { d })
}
