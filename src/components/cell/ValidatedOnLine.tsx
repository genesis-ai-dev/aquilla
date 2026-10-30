import { DateTooltip } from "@/components/ui/date-tooltip"
import { fmtShortCalendarDateTime } from "@/lib/format-date"
import { useI18n } from "@/lib/i18n/I18nProvider"

/**
 * AQU-2296: the date under a validator's name, in the "Text validated by" and
 * "Audio validated by" popovers.
 *
 * ONE component for both lists, which is the point: the two sit side by side
 * on the same line and are meant to read alike, so the second line's size,
 * colour and hover have to come from one place rather than be matched by hand
 * in two files.
 *
 * A name with no known stamp renders NOTHING — not an empty line, and not the
 * "Invalid Date" a bare `new Date(undefined)` would print. That is also what
 * holds while a vote is in flight on a worker that sends no stamps: the row
 * shows the name alone rather than a blank second line that shifts the list.
 * The line says the day AND the clock time — "October 30 at 3:02 PM"
 * (Matthew, 2026-10-30): two votes on one day are told apart by when, and a
 * reviewer checking whether a vote predates an edit needs the hour. The
 * hover keeps the full stamp with seconds, as every other date in the editor
 * does.
 */
export function ValidatedOnLine({ value }: { value: number | null | undefined }) {
  const { t, locale } = useI18n()
  // `> 0` as well as finite: a missing stamp that arrived as 0 would otherwise
  // date the vote to January 1970, which is worse than showing no date at all.
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return (
    <span className="block text-[11px] text-muted-foreground/80">
      <DateTooltip value={value} label={t("org.orgHome.table.validatedHeaderLabel")}>
        {fmtShortCalendarDateTime(value, undefined, locale)}
      </DateTooltip>
    </span>
  )
}
