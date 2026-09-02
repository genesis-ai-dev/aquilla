// AQU-1092…1098: one planning unit in the board.
//
// Carries a lot per row — name, status, four progress figures, a target date
// and an activity time — so the four figures collapse into two stacked bars
// (the app's existing filled/approved rollup shape) rather than four number
// columns. Four numbers for the width of two, and the eye reads bars faster
// than digits when scanning sixty-six rows.

import { useT } from "@/lib/i18n/I18nProvider"
import { planUnitLabel, planUnitStatus, type PlanUnit } from "@/lib/plan/plan-status"
import { PlanStatusPill } from "./PlanStatusPill"

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0
}

/** Two stacked bars: the outer measure over the inner one, as the file
 *  breakdown has always drawn filled-over-approved. */
function DualBar({ outer, inner, outerClass, innerClass, label }: {
  outer: number
  inner: number
  outerClass: string
  innerClass: string
  label: string
}) {
  return (
    <span className="flex w-24 shrink-0 flex-col gap-[3px]" aria-label={label}>
      <span className="block h-1 overflow-hidden rounded-full bg-muted">
        <span className={`block h-full rounded-full ${outerClass}`} style={{ width: `${outer}%` }} />
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-muted">
        <span className={`block h-full rounded-full ${innerClass}`} style={{ width: `${inner}%` }} />
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
  const status = planUnitStatus(unit, now)
  const label = planUnitLabel(unit)
  const translated = pct(unit.filledCount, unit.totalCount)
  const validated = pct(unit.validatedCount, unit.totalCount)
  const recorded = pct(unit.audioCount, unit.totalCount)
  const audioValidated = pct(unit.audioValidatedCount, unit.totalCount)

  return (
    <li>
      <button
        type="button"
        data-testid={`plan-row-${unit.fileId}-${unit.sectionKey}`}
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={`flex w-full items-center gap-3 px-4 py-2 text-start text-xs transition-colors hover:bg-muted/60 ${
          selected ? "bg-muted shadow-[inset_3px_0_0_var(--color-primary)]" : ""
        }`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground">{label}</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t("org.projectOverview.plan.cellCount", { count: unit.totalCount })}
          </span>
        </span>

        <DualBar
          outer={translated}
          inner={validated}
          outerClass="bg-amber-500"
          innerClass="bg-emerald-500"
          label={t("org.projectOverview.plan.textBarsAria", { translated, validated })}
        />
        <span className="w-16 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
          {translated}/{validated}%
        </span>

        {showAudio && (
          <>
            <DualBar
              outer={recorded}
              inner={audioValidated}
              outerClass="bg-sky-500"
              innerClass="bg-sky-700"
              label={t("org.projectOverview.plan.audioBarsAria", { recorded, validated: audioValidated })}
            />
            <span className="w-16 shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
              {recorded}/{audioValidated}%
            </span>
          </>
        )}

        <span className="hidden w-28 shrink-0 justify-end sm:flex">
          <PlanStatusPill status={status} unit={unit} now={now} compact />
        </span>
      </button>
    </li>
  )
}
