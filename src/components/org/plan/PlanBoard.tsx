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
import { useT } from "@/lib/i18n/I18nProvider"
import {
  groupPlanUnits,
  planHasAudio,
  planSummary,
  planUnitId,
  type PlanUnit,
  type PlanUnitStatus,
} from "@/lib/plan/plan-status"
import { PlanRow } from "./PlanRow"
import { PLAN_STATUS_LABEL_KEY } from "./PlanStatusPill"

const GROUP_HINT_KEY: Record<PlanUnitStatus, string> = {
  overdue: "org.projectOverview.plan.groupHintOverdue",
  soon: "org.projectOverview.plan.groupHintSoon",
  in_progress: "org.projectOverview.plan.groupHintInProgress",
  not_started: "org.projectOverview.plan.groupHintNotStarted",
  done: "org.projectOverview.plan.groupHintDone",
}

const GROUP_DOT: Record<PlanUnitStatus, string> = {
  overdue: "bg-destructive",
  soon: "bg-amber-500",
  in_progress: "bg-primary",
  not_started: "bg-muted-foreground/50",
  done: "bg-emerald-500",
}

export function PlanBoard({ units, now, selectedId, onSelect, actions }: {
  units: PlanUnit[]
  now: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Export controls etc., rendered beside the summary. */
  actions?: React.ReactNode
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
    <div className="rounded-lg border bg-card" data-testid="plan-board">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold text-muted-foreground">
            {t("org.projectOverview.plan.heading")}
          </h2>
          <span
            data-testid="plan-summary"
            className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
          >
            {t("org.projectOverview.plan.summaryDone", { done: summary.done, total: summary.total })}
          </span>
          {summary.overdue > 0 && (
            <span
              data-testid="plan-summary-overdue"
              className="rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive"
            >
              {t("org.projectOverview.plan.summaryOverdue", { count: summary.overdue })}
            </span>
          )}
        </div>
        {actions}
      </div>

      {units.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-muted-foreground" data-testid="plan-empty">
          {t("org.projectOverview.plan.empty")}
        </p>
      ) : (
        <div
          ref={listRef}
          role="region"
          tabIndex={0}
          aria-label={t("org.projectOverview.plan.regionAria")}
          onKeyDown={onKeyDown}
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {groups.map((group) => (
            <section key={group.status} data-testid={`plan-group-${group.status}`}>
              <header className="flex items-center gap-2 border-b bg-muted/50 px-4 py-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${GROUP_DOT[group.status]}`} aria-hidden />
                <h3 className="text-[11px] font-semibold">{t(PLAN_STATUS_LABEL_KEY[group.status] as never)}</h3>
                <span className="rounded-full border bg-card px-1.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                  {group.units.length}
                </span>
                <span className="ms-auto hidden text-[11px] text-muted-foreground sm:block">
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
          ))}
          {selectedId && (
            <p className="border-t bg-muted/50 px-4 py-1.5 text-[11px] text-muted-foreground">
              {t("org.projectOverview.plan.keyboardHint")}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
