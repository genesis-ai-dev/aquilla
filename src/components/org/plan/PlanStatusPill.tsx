// AQU-1095/1096: a unit's status, as a dot plus a word.
//
// Never colour alone — "overdue" has to survive a greyscale print and a
// colour-blind reader, so the word carries the meaning and the colour only
// reinforces it.

import { useT } from "@/lib/i18n/I18nProvider"
import { planUnitStatus, PLAN_STATUS_LABEL_KEY, type PlanUnit, type PlanUnitStatus } from "@/lib/plan/plan-status"
import { PLAN_TONE } from "./plan-tone"

export function PlanStatusPill({ status, unit, now, compact = false, plain = false }: {
  status?: PlanUnitStatus
  unit?: PlanUnit
  now: number
  compact?: boolean
  /**
   * AQU-1278 (Sam, 2026-09-17): the dot and the word in the status colour
   * with NO wash, padding or size of its own, so it sits in a line of running
   * text — "120 cells · Nearly complete" — at that line's size and baseline.
   * The pill's box threw the count line off; this is the group header's own
   * vocabulary (dot + coloured word) brought down to the row.
   */
  plain?: boolean
}) {
  const t = useT()
  const resolved = status ?? (unit ? planUnitStatus(unit, now) : "not_started")
  const tone = PLAN_TONE[resolved]
  return (
    <span
      data-testid={`plan-status-${resolved}`}
      className={`inline-flex items-center gap-1.5 font-medium ${tone.text} ${
        plain ? "" : `rounded-full px-2 py-0.5 ${tone.bg} ${compact ? "text-[11px]" : "text-xs"}`
      }`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
      {t(PLAN_STATUS_LABEL_KEY[resolved] as never)}
    </span>
  )
}
