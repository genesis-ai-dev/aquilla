// AQU-1092…1098: the one line beside a unit's status, rendered.
//
// Lives apart from both surfaces that show it — the board row under the date,
// and the inspector beside the pill — so neither owns it and the two can never
// word the same fact differently.

import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatRelativeTime } from "@/lib/i18n/format"
import { planUnitNote, type PlanUnit } from "@/lib/plan/plan-status"

/**
 * Falls back to last activity when the status has nothing to add, so the line
 * is never empty while the unit has a history worth reporting.
 */
export function usePlanUnitNote(unit: PlanUnit, now: number): string | null {
  const t = useT()
  const { locale } = useI18n()
  const note = planUnitNote(unit, now)
  if (note) {
    switch (note.kind) {
      case "marked":
        return t("org.projectOverview.plan.markedOn", {
          date: fmtDeadlineDate(note.at, now, locale),
        })
      case "days_late":
        return t("org.projectOverview.plan.daysLate", { count: note.days })
      case "days_until":
        return t("org.projectOverview.plan.daysUntil", { count: note.days })
      case "no_target":
        return t("org.projectOverview.plan.noTargetDate")
    }
  }
  return unit.lastEditAt != null ? formatRelativeTime(unit.lastEditAt, locale, now) : null
}
