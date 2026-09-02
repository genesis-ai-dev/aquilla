// AQU-1092…1098: one planning unit in the board.
//
// A row carries a lot: name, two-or-four progress figures, the target date the
// unit is planned against, and how recently anyone touched it. Two devices keep
// that scannable across sixty-six rows.
//
// The four progress figures collapse into stacked bars — the app's existing
// filled-over-approved rollup shape — so four numbers cost the width of two and
// the eye reads a bar faster than a digit.
//
// Status is NOT repeated per row: the group header above already says it, and a
// column of thirty-one identical "In progress" chips is noise. What the row
// carries instead is the thing that varies and that the group cannot say — the
// date, and how late or how recent it is.

import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { fmtDeadlineDate } from "@/lib/format-date"
import { formatRelativeTime } from "@/lib/i18n/format"
import { planUnitLabel, planUnitStatus, type PlanUnit } from "@/lib/plan/plan-status"

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/** Two stacked bars: the outer measure over the inner one it contains. */
function DualBar({ label, outer, inner, outerClass, innerClass, aria }: {
  label: string
  outer: number
  inner: number
  outerClass: string
  innerClass: string
  aria: string
}) {
  return (
    <span className="flex items-center gap-2" aria-label={aria}>
      <span className="w-8 shrink-0 text-[9.5px] font-semibold tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="flex w-28 shrink-0 flex-col gap-[3px]">
        <span className="block h-1 overflow-hidden rounded-full bg-muted">
          <span className={`block h-full rounded-full ${outerClass}`} style={{ width: `${outer}%` }} />
        </span>
        <span className="block h-1 overflow-hidden rounded-full bg-muted">
          <span className={`block h-full rounded-full ${innerClass}`} style={{ width: `${inner}%` }} />
        </span>
      </span>
      <span className="w-14 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
        {outer}<span className="opacity-40">/</span>{inner}%
      </span>
    </span>
  )
}

export function PlanRow({ unit, now, selected, showAudio, onSelect }: {
  unit: PlanUnit
  now: number
  selected: boolean
  showAudio: boolean
  onSelect: () => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const status = planUnitStatus(unit, now)
  const translated = pct(unit.filledCount, unit.totalCount)
  const validated = pct(unit.validatedCount, unit.totalCount)

  // The line under the date answers "how late" for something overdue, "when was
  // this decided" for something done, and "when was it last touched" otherwise
  // — always the most useful fact the date alone cannot give.
  const daysLate =
    status === "overdue" && unit.targetDate
      ? Math.floor((now - Date.parse(unit.targetDate) - 36 * 60 * 60 * 1000) / 86_400_000) + 1
      : null
  const note =
    daysLate != null && daysLate > 0
      ? t("org.projectOverview.plan.daysLate", { count: daysLate })
      : unit.doneAt != null
        ? t("org.projectOverview.plan.markedOn", { date: fmtDeadlineDate(unit.doneAt, undefined, locale) })
        : unit.lastEditAt != null
          ? formatRelativeTime(unit.lastEditAt, locale, now)
          : null

  return (
    <li>
      <button
        type="button"
        data-testid={`plan-row-${unit.fileId}-${unit.sectionKey}`}
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={`flex w-full items-center gap-4 px-4 py-2 text-start text-xs transition-colors hover:bg-muted/60 ${
          selected ? "bg-muted shadow-[inset_3px_0_0_var(--color-primary)]" : ""
        }`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground">{planUnitLabel(unit)}</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t("org.projectOverview.plan.cellCount", { count: unit.totalCount })}
          </span>
        </span>

        <span className="hidden flex-col gap-[5px] md:flex">
          <DualBar
            label={t("org.projectOverview.plan.textBarLabel")}
            outer={translated}
            inner={validated}
            outerClass="bg-amber-500"
            innerClass="bg-emerald-500"
            aria={t("org.projectOverview.plan.textBarsAria", { translated, validated })}
          />
          {showAudio && (
            <DualBar
              label={t("org.projectOverview.plan.audioBarLabel")}
              outer={pct(unit.audioCount, unit.totalCount)}
              inner={pct(unit.audioValidatedCount, unit.totalCount)}
              outerClass="bg-sky-500"
              innerClass="bg-sky-700"
              aria={t("org.projectOverview.plan.audioBarsAria", {
                recorded: pct(unit.audioCount, unit.totalCount),
                validated: pct(unit.audioValidatedCount, unit.totalCount),
              })}
            />
          )}
        </span>

        {/* The reason the board exists: when is it due, and how is it going. */}
        <span className="flex w-32 shrink-0 flex-col items-end gap-0.5">
          <span
            data-testid={`plan-date-${unit.fileId}-${unit.sectionKey}`}
            className={`tabular-nums ${
              status === "overdue" ? "font-semibold text-destructive" : "text-foreground"
            } ${unit.targetDate ? "" : "text-muted-foreground"}`}
          >
            {unit.targetDate
              ? fmtDeadlineDate(unit.targetDate, undefined, locale)
              : t("org.projectOverview.plan.noTargetShort")}
          </span>
          {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
        </span>
      </button>
    </li>
  )
}
