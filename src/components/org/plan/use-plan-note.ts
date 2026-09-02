// AQU-1092…1098: the one line beside a unit's status, rendered.
//
// Lives apart from both surfaces that show it — the board row under the date,
// and the inspector beside the pill — so neither owns it and the two can never
// word the same fact differently. They do read it differently, though, because
// what surrounds it differs, and each variant below says how.

import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatRelativeTime } from "@/lib/i18n/format"
import { planUnitNote, type PlanUnit } from "@/lib/plan/plan-status"

function useRenderNote(): (unit: PlanUnit, now: number) => string | null {
  const t = useT()
  const { locale } = useI18n()
  return (unit, now) => {
    const note = planUnitNote(unit, now)
    if (!note) return null
    switch (note.kind) {
      case "marked":
        return t("org.projectOverview.plan.markedOn", { date: fmtDeadlineDate(note.at, now, locale) })
      case "days_late":
        return t("org.projectOverview.plan.daysLate", { count: note.days })
      case "days_until":
        return t("org.projectOverview.plan.daysUntil", { count: note.days })
      case "no_target":
        return t("org.projectOverview.plan.noTargetDate")
    }
  }
}

/**
 * The inspector's note, beside the status pill: the status and nothing else.
 * Activity has its own line further down, so repeating it here would say the
 * same thing twice within one panel.
 */
export function usePlanStatusNote(unit: PlanUnit, now: number): string | null {
  return useRenderNote()(unit, now)
}

/**
 * The board row's note, under the target date.
 *
 * Differs from the inspector's in one way: "no target date" gives way to last
 * activity, because the date immediately above it is already an em dash saying
 * exactly that. On a sixty-six-row Bible the status version put the same four
 * words down the whole column and buried the one fact that varies per row.
 */
export function usePlanRowNote(unit: PlanUnit, now: number): string | null {
  const { locale } = useI18n()
  const note = planUnitNote(unit, now)
  const rendered = useRenderNote()(unit, now)
  const activity = unit.lastEditAt != null ? formatRelativeTime(unit.lastEditAt, locale, now) : null
  if (!note || note.kind === "no_target") return activity
  return rendered
}
