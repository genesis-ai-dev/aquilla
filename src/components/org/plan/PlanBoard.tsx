// AQU-1092…1098: the project plan — the dashboard's centrepiece.
//
// Rows are PLANNING UNITS grouped by status, in urgency order, because the
// grouping IS the answer: "what needs me today" is readable before any
// individual row is. Overdue sits at the top as the only group anyone acts on
// now; Done sinks to the bottom, present as evidence but out of the way.
// Empty groups are dropped, so a healthy project reads as a short page.
//
// Nothing here names the unit. It is a Bible book in one project, an episode
// in another, a document in a third — so the heading is "Plan" and the summary
// says "2 of 6 done".

import { useCallback, useMemo, useRef } from "react"
import { SearchX } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { TableEmptyState } from "@/components/ui/empty"
import {
  groupPlanUnits,
  planHasAudio,
  planSummary,
  planUnitId,
  PLAN_STATUS_LABEL_KEY,
  type PlanUnit,
  type PlanUnitStatus,
} from "@/lib/plan/plan-status"
import { PLAN_TONE } from "./plan-tone"
import { PlanRow } from "./PlanRow"

const GROUP_HINT_KEY: Record<PlanUnitStatus, string> = {
  overdue: "org.projectOverview.plan.groupHintOverdue",
  soon: "org.projectOverview.plan.groupHintSoon",
  in_progress: "org.projectOverview.plan.groupHintInProgress",
  not_started: "org.projectOverview.plan.groupHintNotStarted",
  done: "org.projectOverview.plan.groupHintDone",
}

/**
 * A figure and its label. The numeral is rendered outside the translated
 * string so it can carry the weight that makes the strip scannable; the label
 * keeps every word — and the total — inside translatable text.
 */
function PlanStat({ value, label, tone, testId }: {
  value: number
  label: string
  tone?: "late"
  testId: string
}) {
  const late = tone === "late"
  return (
    // Laid out as inline text, NOT as a flex row: flex would put the numeral
    // and the label in separate boxes with only a `gap` between them, which
    // looks spaced but reads as "1of 3 done" to anything consuming the text —
    // a screen reader, a copy-paste, an assertion. Inline flow gives a real
    // word space and the baseline alignment the design wants for free.
    <span
      data-testid={testId}
      className={`whitespace-nowrap rounded-full px-[11px] py-1 text-[12.5px] ${
        late ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
      }`}
    >
      <b
        className={`me-0.5 text-sm font-semibold tabular-nums ${
          late ? "text-destructive" : "text-foreground"
        }`}
      >
        {value}
      </b>{" "}
      {label}
    </span>
  )
}

export function PlanBoard({ units, now, selectedId, onSelect, actions, emptyAction }: {
  units: PlanUnit[]
  now: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Export controls etc., rendered beside the summary. */
  actions?: React.ReactNode
  /** The one action that creates rows, offered when there are none. */
  emptyAction?: React.ReactNode
}) {
  const t = useT()
  const listRef = useRef<HTMLDivElement | null>(null)
  const groups = useMemo(() => groupPlanUnits(units, now), [units, now])
  const summary = useMemo(() => planSummary(units, now), [units, now])
  // Audio bars vanish entirely on a text-only project rather than showing a
  // column of zeroes, matching what the Progress card already does.
  const showAudio = useMemo(() => planHasAudio(units), [units])
  /** Rows in the order they appear, which is the order the arrows walk. */
  const ordered = useMemo(() => groups.flatMap((g) => g.units), [groups])

  const step = useCallback(
    (delta: number) => {
      if (ordered.length === 0) return
      const index = ordered.findIndex((u) => planUnitId(u) === selectedId)
      const next = ordered[Math.min(ordered.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta))]
      if (next) onSelect(planUnitId(next))
    },
    [ordered, selectedId, onSelect],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Attached to the list, not window, so it never fights a dialog's Esc.
      if (e.key === "ArrowDown") { e.preventDefault(); step(1) }
      else if (e.key === "ArrowUp") { e.preventDefault(); step(-1) }
      else if (e.key === "Escape" && selectedId) { e.preventDefault(); onSelect(null) }
    },
    [step, selectedId, onSelect],
  )

  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid="plan-board">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-[17px] py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="me-1 text-xs font-semibold text-muted-foreground">
            {t("org.projectOverview.plan.heading")}
          </h2>
          <PlanStat
            testId="plan-summary"
            value={summary.done}
            label={t("org.projectOverview.plan.summaryDoneLabel", { total: summary.total })}
          />
          {summary.overdue > 0 && (
            <PlanStat
              testId="plan-summary-overdue"
              value={summary.overdue}
              tone="late"
              label={t("org.projectOverview.plan.summaryOverdueLabel", { count: summary.overdue })}
            />
          )}
          {summary.inFlight > 0 && (
            <PlanStat
              testId="plan-summary-in-progress"
              value={summary.inFlight}
              label={t("org.projectOverview.plan.summaryInProgressLabel", { count: summary.inFlight })}
            />
          )}
        </div>
        {actions}
      </div>

      {units.length === 0 ? (
        <TableEmptyState
          data-testid="plan-empty"
          icon={SearchX}
          title={t("org.projectOverview.plan.emptyTitle")}
          description={t("org.projectOverview.plan.empty")}
          action={emptyAction}
        />
      ) : (
        <div
          ref={listRef}
          role="region"
          tabIndex={0}
          aria-label={t("org.projectOverview.plan.regionAria")}
          onKeyDown={onKeyDown}
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {groups.map((group) => {
            const tone = PLAN_TONE[group.status]
            return (
              <section key={group.status} data-testid={`plan-group-${group.status}`}>
                <header className="flex items-center gap-2.5 border-y bg-muted px-[17px] py-[11px] first:border-t-0">
                  <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${tone.dot}`} aria-hidden />
                  <h3 className={`text-[12.5px] font-semibold ${tone.text}`}>
                    {t(PLAN_STATUS_LABEL_KEY[group.status] as never)}
                  </h3>
                  <span className="rounded-full border bg-card px-[7px] text-[11px] font-bold tabular-nums text-muted-foreground">
                    {group.units.length}
                  </span>
                  <span className="ms-auto hidden text-[11.5px] text-muted-foreground sm:block">
                    {t(GROUP_HINT_KEY[group.status] as never)}
                  </span>
                </header>
                <ul className="divide-y">
                  {group.units.map((unit) => (
                    <PlanRow
                      key={planUnitId(unit)}
                      unit={unit}
                      now={now}
                      showAudio={showAudio}
                      selected={planUnitId(unit) === selectedId}
                      onSelect={() => onSelect(planUnitId(unit))}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
          {selectedId && (
            <p className="border-t bg-muted px-[17px] py-2 text-[11.5px] text-muted-foreground">
              {t("org.projectOverview.plan.keyboardHint")}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
