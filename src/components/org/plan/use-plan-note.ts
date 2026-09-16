// AQU-1092…1098: the one line beside a unit's status, rendered.
//
// Lives apart from both surfaces that show it — the board row under the date,
// and the inspector beside the pill — so neither owns it and the two can never
// word the same fact differently. They do read it differently, though, because
// what surrounds it differs, and each variant below says how.
//
// AQU-1278 added a second fact with exactly that problem: what a unit still has
// left. The row says it in the date column, the inspector says it beside the
// pill and again over the chapter grid, and a manager reading "6 cells to
// validate" in one place and "6 to go" in the other would reasonably wonder
// whether they are the same six. So its renderer lives here as well.

import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatRelativeTime } from "@/lib/i18n/format"
import {
  planShortfallParts,
  planUnitNote,
  planUnitStatus,
  type PlanShortfall,
  type PlanShortfallPart,
  type PlanUnit,
} from "@/lib/plan/plan-status"

function useRenderNote(): (
  unit: PlanUnit,
  now: number,
  audioFiles?: ReadonlySet<string>,
) => string | null {
  const t = useT()
  const { locale } = useI18n()
  return (unit, now, audioFiles) => {
    const note = planUnitNote(unit, now, audioFiles)
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
 * AQU-1278: one i18n key per outstanding medium.
 *
 * Exhaustive BY TYPE, unlike its cousin `PLAN_STATUS_LABEL_KEY` over in
 * plan-status.ts: a kind added to `PlanShortfallPart` and forgotten here stops
 * the build rather than rendering the raw key string into a row.
 */
const SHORTFALL_KEY: Record<PlanShortfallPart["kind"], string> = {
  translate: "org.projectOverview.plan.shortfallTranslate",
  validate: "org.projectOverview.plan.shortfallValidate",
  record: "org.projectOverview.plan.shortfallRecord",
  audio_validate: "org.projectOverview.plan.shortfallAudioValidate",
}

/**
 * AQU-1278: what a unit still needs, as one string — "6 cells to translate ·
 * 34 cells to validate".
 *
 * A FACTORY rather than a hook that takes the shortfall, because the inspector
 * renders one of these per assignment inside a `map` and the rules of hooks
 * forbid calling a hook there. `usePlanShortfallText` below is the
 * single-value form the row uses; both go through this, so they cannot drift.
 *
 * NULL MEANS NOTHING IS OUTSTANDING, which is a different claim from having
 * nothing to say, and the two surfaces say it differently — the row spends its
 * date line on "Nothing left" where the inspector has a grid of complete tiles
 * making the same point in colour. Returning that string from here would force
 * the row's arrangement on every caller.
 */
export function usePlanShortfallRenderer(): (shortfall: PlanShortfall) => string | null {
  const t = useT()
  return (shortfall) => {
    // `planShortfallParts` has already dropped the zero terms, ordered what is
    // left worst-first, and capped it at two. The pair is a key of its own so a
    // language that joins clauses with something other than a middot can.
    const [first, second] = planShortfallParts(shortfall).map((part) =>
      t(SHORTFALL_KEY[part.kind] as never, { count: part.count }),
    )
    if (!first) return null
    if (!second) return first
    return t("org.projectOverview.plan.shortfallPair", { first, second })
  }
}

/** The single-value form of `usePlanShortfallRenderer`, for one fixed unit. */
export function usePlanShortfallText(shortfall: PlanShortfall): string | null {
  return usePlanShortfallRenderer()(shortfall)
}

/**
 * The inspector's note, beside the status pill: the status and nothing else.
 * Activity has its own line further down, so repeating it here would say the
 * same thing twice within one panel.
 *
 * `audioFiles` is the set from `audioFileIds` over the WHOLE board; see
 * `planUnitStatus` for why a unit's own audio count is the wrong judge.
 */
export function usePlanStatusNote(
  unit: PlanUnit,
  now: number,
  audioFiles?: ReadonlySet<string>,
): string | null {
  return useRenderNote()(unit, now, audioFiles)
}

/**
 * The board row's note, under the target date.
 *
 * Differs from the inspector's in one way: "no target date" gives way to last
 * activity, because the date immediately above it is already an em dash saying
 * exactly that. On a sixty-six-row Bible the status version put the same four
 * words down the whole column and buried the one fact that varies per row.
 *
 * AQU-1278 TAKES THAT SUBSTITUTION BACK, for nearly-complete units and only for
 * them. The swap was never really about the words; it was about the em dash
 * directly above them. An undated nearly-complete unit no longer HAS that em
 * dash — the row spends its first line on the shortfall instead — so nothing
 * else in the row says the unit is unplanned, and these four words are once
 * again the only place it is said. Last activity is what gives way this time,
 * and for the same reason it won before: on a unit six cells from done, what is
 * left is the fact that varies down the column, and the hour of the last edit
 * is not.
 */
export function usePlanRowNote(
  unit: PlanUnit,
  now: number,
  audioFiles?: ReadonlySet<string>,
): string | null {
  const { locale } = useI18n()
  const note = planUnitNote(unit, now, audioFiles)
  const rendered = useRenderNote()(unit, now, audioFiles)
  const activity = unit.lastEditAt != null ? formatRelativeTime(unit.lastEditAt, locale, now) : null
  const nearlyComplete = planUnitStatus(unit, now, audioFiles) === "nearly_complete"
  if (!note) return activity
  if (note.kind === "no_target" && !nearlyComplete) return activity
  return rendered
}
