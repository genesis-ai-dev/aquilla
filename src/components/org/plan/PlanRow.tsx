// AQU-1092…1098: one planning unit in the board.
//
// Three columns, because a row answers three questions in a fixed order: what
// is this, how is it going, and when is it due. The bars take the widest track
// and stretch — they are the only part that carries a shape rather than a word,
// so they get the room to be read at a glance across sixty-six rows.
//
// Status is NOT repeated per row. The group header above already says it, and a
// column of thirty-one identical "In progress" chips is noise. What the row
// carries instead is the thing that varies and the group cannot say: the date,
// and the one line that says how late, how soon, or how recently touched.

import { useT, useI18n } from "@/lib/i18n/I18nProvider"
import { fmtDeadlineDate } from "@/lib/format-date"
import { planPct, planUnitLabel, planUnitStatus, type PlanUnit } from "@/lib/plan/plan-status"
import { PlanBar } from "./PlanBar"
import { usePlanUnitNote } from "./use-plan-note"

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
  const translated = planPct(unit.filledCount, unit.totalCount)
  const validated = planPct(unit.validatedCount, unit.totalCount)
  const recorded = planPct(unit.audioCount, unit.totalCount)
  const audioValidated = planPct(unit.audioValidatedCount, unit.totalCount)
  const note = usePlanUnitNote(unit, now)

  return (
    <li>
      <button
        type="button"
        data-testid={`plan-row-${unit.fileId}-${unit.sectionKey}`}
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={`grid w-full grid-cols-1 items-center gap-2 px-[17px] py-3 text-start transition-colors hover:bg-muted/60 md:grid-cols-[minmax(150px,1.1fr)_minmax(190px,1.4fr)_minmax(130px,0.8fr)] md:gap-4 ${
          selected ? "bg-muted shadow-[inset_3px_0_0_var(--color-primary)]" : ""
        }`}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-semibold text-foreground">
            {planUnitLabel(unit)}
          </span>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">
            {t("org.projectOverview.plan.cellCount", { count: unit.totalCount })}
          </span>
        </span>

        <span className="flex flex-col gap-[5px]">
          <PlanBar
            label={t("org.projectOverview.plan.textBarLabel")}
            outer={translated}
            inner={validated}
            tone="text"
            aria={t("org.projectOverview.plan.textBarsAria", { translated, validated })}
          />
          {showAudio && (
            <PlanBar
              label={t("org.projectOverview.plan.audioBarLabel")}
              outer={recorded}
              inner={audioValidated}
              tone="audio"
              aria={t("org.projectOverview.plan.audioBarsAria", {
                recorded,
                validated: audioValidated,
              })}
            />
          )}
        </span>

        {/* The reason the board exists: when is it due, and how is it going. */}
        <span className="flex flex-col gap-0.5 md:text-end">
          <span
            data-testid={`plan-date-${unit.fileId}-${unit.sectionKey}`}
            className={`text-[12.5px] tabular-nums ${
              status === "overdue"
                ? "font-semibold text-destructive"
                : unit.targetDate
                  ? "text-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {unit.targetDate
              ? fmtDeadlineDate(unit.targetDate, now, locale)
              : t("org.projectOverview.plan.noTargetShort")}
          </span>
          <span className="text-[11.5px] text-muted-foreground">
            {note ?? "—"}
          </span>
        </span>
      </button>
    </li>
  )
}
