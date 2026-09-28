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
import { formatNumber, formatRelativeTime } from "@/lib/i18n/format"
import {
  planShortfallParts,
  planUnitNote,
  planUnitStatus,
  type PlanShortfall,
  type PlanShortfallPart,
  type PlanUnit,
  type PlanOpenKind,
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
 * AQU-1278: the same four without their nouns, for a line carrying two terms.
 *
 * "6 cells to translate · 8 cells to validate" is two hundred pixels of a
 * column that starts at a hundred and seventy, so it wraps and takes the row's
 * height with it. It also says "cells" twice about the same cells. Dropping the
 * noun is only safe WITH a second term beside it — alone, "6 to validate" has
 * nothing to say what six of anything are — which is why this is chosen by the
 * number of parts and not by a caller's flag.
 */
const SHORTFALL_BRIEF_KEY: Record<PlanShortfallPart["kind"], string> = {
  translate: "org.projectOverview.plan.shortfallTranslateBrief",
  validate: "org.projectOverview.plan.shortfallValidateBrief",
  record: "org.projectOverview.plan.shortfallRecordBrief",
  audio_validate: "org.projectOverview.plan.shortfallAudioValidateBrief",
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
export function usePlanShortfallRenderer(): (
  shortfall: PlanShortfall,
  /**
   * "auto" — the default — takes the brief wording only when two terms share
   * the line. "brief" forces it, for a caller who knows something ELSE will
   * share it: the inspector's assignment rows append the chapter the work is
   * in, so "2 cells to validate · ch. 12" is the same one-noun-too-many the
   * brief forms exist to avoid, on a panel a third the board's width.
   */
  mode?: "auto" | "brief",
) => string | null {
  const t = useT()
  return (shortfall, mode = "auto") => {
    // `planShortfallParts` has already dropped the zero terms, ordered what is
    // left worst-first, and capped it at two. The pair is a key of its own so a
    // language that joins clauses with something other than a middot can.
    //
    // The noun survives only on a line carrying ONE fragment and nothing else,
    // where there is room for it and no context to borrow from.
    const parts = planShortfallParts(shortfall)
    const keys = mode === "brief" || parts.length > 1 ? SHORTFALL_BRIEF_KEY : SHORTFALL_KEY
    const [first, second] = parts.map((part) =>
      t(keys[part.kind] as never, { count: part.count }),
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

/**
 * What the link into the editor says, per queue. Four separate strings rather
 * than one with a slot, because "first untranslated" inflects as a whole in
 * most languages. Shared by the board row and the inspector so the two can
 * never describe the same destination differently.
 */
export const GO_TO_FIRST_KEY: Record<PlanOpenKind, string> = {
  untranslated: "org.projectOverview.plan.goToFirstUntranslated",
  unvalidated: "org.projectOverview.plan.goToFirstUnvalidated",
  unrecorded: "org.projectOverview.plan.goToFirstUnrecorded",
  unsigned: "org.projectOverview.plan.goToFirstUnsigned",
}

/**
 * AQU-1278, round 7: what a bar's two percentages stand for, as sentences for
 * their hover tips — "1,530 of 1,533 validated". `total` is the BAR's own
 * denominator: the unit's cells for text, and for audio whatever
 * `planAudioTotal` says, which on a dubbing project is the cue sheet's count.
 * Numbers are formatted for the reader's locale here because the catalog's
 * interpolation does not group digits, and "1530 of 1533" is not how anyone
 * writes a number.
 */
export function usePlanReadoutTips(): (
  tone: "text" | "audio",
  done: number,
  validated: number,
  total: number,
) => { outer: string; inner: string } {
  const t = useT()
  const { locale } = useI18n()
  return (tone, done, validated, total) => {
    const n = (v: number) => formatNumber(v, locale)
    const vars = (v: number) => ({ done: n(v), total: n(total) })
    return tone === "text"
      ? {
          outer: t("org.projectOverview.plan.readoutTranslated", vars(done)),
          inner: t("org.projectOverview.plan.readoutValidated", vars(validated)),
        }
      : {
          outer: t("org.projectOverview.plan.readoutRecorded", vars(done)),
          inner: t("org.projectOverview.plan.readoutAudioValidated", vars(validated)),
        }
  }
}
