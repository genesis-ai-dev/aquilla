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
//
// AQU-1096 asks that the table be sortable or filterable. The grouping already
// brings live work to the top, but sixty-six rows need more than that, and the
// Files card this replaced had a name filter that went with it — so the second
// header row carries four controls: a name filter, an arrangement toggle, a
// "needs a date" narrowing, and per-group folds.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search, X, ChevronDown, ChevronRight, CalendarOff, AlertTriangle } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { TableEmptyState } from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  filterPlanUnits,
  groupPlanUnits,
  planHasAudio,
  planSummary,
  planUnitId,
  PLAN_STATUS_LABEL_KEY,
  type PlanUnit,
  type PlanUnitStatus,
} from "@/lib/plan/plan-status"
import {
  loadCollapsedGroups,
  loadPlanView,
  saveCollapsedGroups,
  savePlanView,
  toggleCollapsedGroup,
  type PlanViewMode,
} from "@/lib/plan/plan-view"
import type { PlanStatus } from "@/hooks/useProjectPlan"
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

export function PlanBoard({
  units, now, projectId, selectedId, onSelect, actions, emptyAction,
  status = "ready", onRetry, orderRef,
}: {
  units: PlanUnit[]
  now: number
  /** Scopes the per-project group folds. Null while the route id is unresolved. */
  projectId: string | null
  selectedId: string | null
  onSelect: (id: string | null) => void
  /**
   * The plan read's state. Without it an empty `units` means three different
   * things — still loading, failed, or genuinely nothing to plan — and the
   * board would tell a PM with sixty-six books that their project is empty.
   */
  status?: PlanStatus
  /** Retries a failed read. */
  onRetry?: () => void
  /**
   * Receives the rows as drawn, in drawn order. The inspector's prev/next
   * buttons live outside this component but must walk exactly what is on
   * screen, and the filters and folds that decide that are state in here.
   * A ref rather than a callback: the parent reads it in an event handler,
   * so there is nothing to re-render and no update loop to create.
   */
  orderRef?: React.MutableRefObject<PlanUnit[]>
  /** Export controls etc., rendered beside the summary. */
  actions?: React.ReactNode
  /** The one action that creates rows, offered when there are none. */
  emptyAction?: React.ReactNode
}) {
  const t = useT()
  const listRef = useRef<HTMLDivElement | null>(null)

  // Both narrowings are EPHEMERAL. A filter that survived a reload would hide
  // rows on arrival with no visible cause, which is how a PM concludes their
  // data is missing.
  const [query, setQuery] = useState("")
  const [needsDateOnly, setNeedsDateOnly] = useState(false)
  // Arrangement is a working style, so it persists globally; folds belong to
  // the project whose groups they hide. See `plan-view.ts`.
  const [view, setView] = useState<PlanViewMode>(() => loadPlanView())
  const [collapsed, setCollapsed] = useState<Set<PlanUnitStatus>>(() => loadCollapsedGroups(projectId))
  useEffect(() => setCollapsed(loadCollapsedGroups(projectId)), [projectId])

  const chooseView = useCallback((next: PlanViewMode) => {
    setView(next)
    savePlanView(next)
  }, [])

  const toggleGroup = useCallback((status: PlanUnitStatus) => {
    setCollapsed((prev) => {
      const next = toggleCollapsedGroup(prev, status)
      saveCollapsedGroups(projectId, next)
      return next
    })
  }, [projectId])

  const clearFilters = useCallback(() => {
    setQuery("")
    setNeedsDateOnly(false)
  }, [])

  const filtering = query.trim().length > 0 || needsDateOnly
  const visible = useMemo(
    () => filterPlanUnits(units, { query, needsDateOnly }),
    [units, query, needsDateOnly],
  )
  const groups = useMemo(() => groupPlanUnits(visible, now), [visible, now])

  // The summary counts the WHOLE project, never the filtered view. "1 of 3
  // done" under a filter that hid the other sixty-three would be a lie, and
  // the strip is the one thing on this card a reader trusts without checking.
  const summary = useMemo(() => planSummary(units, now), [units, now])
  // Audio bars vanish entirely on a text-only project rather than showing a
  // column of zeroes, matching what the Progress card already does. Judged on
  // the whole project so a filter cannot make a column appear and disappear.
  const showAudio = useMemo(() => planHasAudio(units), [units])

  /**
   * The rows the arrows walk: exactly what is on screen, in the order it is
   * drawn. Anything filtered out or folded away is skipped, because stepping
   * onto a row nobody can see would move the inspector for no visible reason.
   */
  const ordered = useMemo(() => {
    if (view === "order") return visible
    return groups.flatMap((g) => (collapsed.has(g.status) ? [] : g.units))
  }, [view, visible, groups, collapsed])

  useEffect(() => {
    if (orderRef) orderRef.current = ordered
  }, [orderRef, ordered])

  /**
   * Moving the selection must move the FOCUS RING with it. Without this the
   * ring stays on the row the reader tabbed to while the highlight and the
   * inspector move somewhere else, Enter re-selects the row behind them, and a
   * screen reader announces nothing at all — `aria-current` changing on an
   * unfocused element is silent.
   */
  const focusRow = useCallback((id: string) => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-plan-unit="${CSS.escape(id)}"]`)
      ?.focus()
  }, [])

  const step = useCallback(
    (delta: number) => {
      if (ordered.length === 0) return
      const index = ordered.findIndex((u) => planUnitId(u) === selectedId)
      // Nothing selected yet means the cursor sits BEFORE the first row, so
      // either arrow lands on it. Treating -1 as 0 made ArrowDown skip to the
      // second row while ArrowUp correctly chose the first.
      const next = index < 0
        ? ordered[0]
        : ordered[Math.min(ordered.length - 1, Math.max(0, index + delta))]
      if (next) {
        const id = planUnitId(next)
        onSelect(id)
        focusRow(id)
      }
    },
    [ordered, selectedId, onSelect, focusRow],
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

  const renderRow = (unit: PlanUnit) => (
    <PlanRow
      key={planUnitId(unit)}
      unit={unit}
      now={now}
      showAudio={showAudio}
      // In Order mode no header above the row carries its status, so the row
      // carries it itself.
      showStatus={view === "order"}
      selected={planUnitId(unit) === selectedId}
      onSelect={() => onSelect(planUnitId(unit))}
    />
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

      {/* Controls. Hidden when there is nothing to arrange — a filter box over
          an empty state is furniture. */}
      {units.length > 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-b px-[17px] py-2"
          data-testid="plan-controls"
        >
          <InputGroup className="h-7 w-full max-w-[260px] rounded-lg">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="text"
              role="searchbox"
              // The password-manager suppressors a named input needs; without
              // them 1Password and LastPass overlay their own icons on it.
              name="aquilla-plan-filter-query"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              data-testid="plan-filter"
              aria-label={t("org.projectOverview.plan.filterAria")}
              placeholder={t("org.projectOverview.plan.filterPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="text-xs"
            />
            {query && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  type="button"
                  size="icon-xs"
                  data-testid="plan-filter-clear"
                  aria-label={t("org.projectOverview.plan.clearFilter")}
                  onClick={() => setQuery("")}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>

          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="plan-needs-date"
              aria-pressed={needsDateOnly}
              title={t("org.projectOverview.plan.needsDateTooltip")}
              onClick={() => setNeedsDateOnly((v) => !v)}
              className={needsDateOnly ? "bg-accent text-foreground" : undefined}
            >
              <CalendarOff className="h-3 w-3" />
              {t("org.projectOverview.plan.needsDate")}
            </Button>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {/* Two buttons with aria-pressed rather than the unused base-ui
                ToggleGroup: this is the pattern the search dock already uses
                for a mode switch, and it has consumers to be consistent with. */}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="plan-view-status"
              aria-pressed={view === "status"}
              onClick={() => chooseView("status")}
              className={view === "status" ? "bg-accent text-foreground" : undefined}
            >
              {t("org.projectOverview.plan.viewStatus")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="plan-view-order"
              aria-pressed={view === "order"}
              onClick={() => chooseView("order")}
              className={view === "order" ? "bg-accent text-foreground" : undefined}
            >
              {t("org.projectOverview.plan.viewOrder")}
            </Button>
          </div>
        </div>
      )}

      {status === "error" && units.length === 0 ? (
        // A failed read is NOT an empty project. Saying "nothing to plan yet"
        // here tells a PM with sixty-six books that their work has vanished,
        // and offers them an import they do not need.
        <TableEmptyState
          data-testid="plan-error"
          icon={AlertTriangle}
          title={t("org.projectOverview.plan.errorTitle")}
          description={t("org.projectOverview.plan.error")}
          action={onRetry ? (
            <Button variant="outline" size="sm" data-testid="plan-retry" onClick={onRetry}>
              {t("common.retry")}
            </Button>
          ) : undefined}
        />
      ) : units.length === 0 && status !== "ready" ? (
        <p className="px-[17px] py-10 text-center text-xs text-muted-foreground" data-testid="plan-loading">
          {t("org.projectOverview.plan.loading")}
        </p>
      ) : units.length === 0 ? (
        <TableEmptyState
          data-testid="plan-empty"
          icon={Search}
          title={t("org.projectOverview.plan.emptyTitle")}
          description={t("org.projectOverview.plan.empty")}
          action={emptyAction}
        />
      ) : visible.length === 0 ? (
        // A filter that matched nothing is a DIFFERENT state from a project
        // with nothing in it, and it needs a different way out.
        <TableEmptyState
          data-testid="plan-no-match"
          icon={Search}
          title={t("org.projectOverview.plan.noMatchTitle")}
          description={t("org.projectOverview.plan.noMatch")}
          action={
            <Button variant="outline" size="sm" data-testid="plan-clear-filters" onClick={clearFilters}>
              {t("common.clear")}
            </Button>
          }
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
          {view === "order" ? (
            // The server already sorts by canonical ordinal then name, so the
            // "in order" arrangement is the payload untouched — no client sort.
            <ul className="divide-y" data-testid="plan-order-list">
              {visible.map(renderRow)}
            </ul>
          ) : (
            groups.map((group) => {
              const tone = PLAN_TONE[group.status]
              const folded = collapsed.has(group.status)
              return (
                <section key={group.status} data-testid={`plan-group-${group.status}`}>
                  {/*
                    * The HEADING WRAPS THE BUTTON, not the other way round. A
                    * button may only contain phrasing content, and an <h3> is
                    * flow content — nesting it inside made the markup invalid
                    * and dropped every group out of heading navigation, which
                    * is how a screen-reader user skims a page like this.
                    */}
                  <h3 className="contents">
                    <button
                      type="button"
                      // NOT `plan-group-toggle-*`: tests select groups with a
                      // `[data-testid^="plan-group-"]` prefix, which that would
                      // shadow. Same trap the date column hit.
                      data-testid={`plan-fold-${group.status}`}
                      aria-expanded={!folded}
                      onClick={() => toggleGroup(group.status)}
                      className={`flex w-full items-center gap-2.5 border-y bg-muted px-[17px] py-[11px] text-start text-[12.5px] font-semibold transition-colors first:border-t-0 hover:bg-muted/70 ${tone.text}`}
                    >
                      {folded
                        ? <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                        : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
                      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${tone.dot}`} aria-hidden />
                      {t(PLAN_STATUS_LABEL_KEY[group.status] as never)}
                      <span className="rounded-full border bg-card px-[7px] text-[11px] font-bold tabular-nums text-muted-foreground">
                        {group.units.length}
                      </span>
                      <span className="ms-auto hidden font-normal text-[11.5px] text-muted-foreground sm:block">
                        {t(GROUP_HINT_KEY[group.status] as never)}
                      </span>
                    </button>
                  </h3>
                  {!folded && <ul className="divide-y">{group.units.map(renderRow)}</ul>}
                </section>
              )
            })
          )}
          {filtering && (
            <p className="border-t bg-muted px-[17px] py-2 text-[11.5px] text-muted-foreground"
               data-testid="plan-filter-note">
              {t("org.projectOverview.plan.showingCount", {
                shown: visible.length,
                total: units.length,
              })}
            </p>
          )}
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
