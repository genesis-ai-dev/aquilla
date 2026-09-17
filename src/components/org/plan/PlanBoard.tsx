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
import {
  Search, X, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CalendarOff, AlertTriangle,
} from "lucide-react"
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
  audioFileIds,
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

/**
 * The line of small print on the right of each group header. It exists because
 * a group whose membership nobody can predict reads as a bug — and AQU-1278's
 * group is the one that most needs it, since "nearly" is a rule rather than a
 * fact a reader can see in the row. Its hint spells the threshold out.
 *
 * TYPE-CHECKED, unlike `PLAN_GROUP_ORDER`: this is an exhaustive Record, so a
 * status added to the union without a hint here fails the build rather than
 * rendering a group with a blank margin.
 */
const GROUP_HINT_KEY: Record<PlanUnitStatus, string> = {
  overdue: "org.projectOverview.plan.groupHintOverdue",
  soon: "org.projectOverview.plan.groupHintSoon",
  nearly_complete: "org.projectOverview.plan.groupHintNearlyComplete",
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
  /**
   * AQU-1278: the status this figure counts, which colours the pill from the
   * SAME table the group headers and the inspector's pill read
   * (`plan-tone.ts`). Grey for a pill that counts no single status — "5 of 66
   * done" spans the whole board — and grey was every pill's colour before this,
   * which made the strip a row of identical lozenges with the one number a
   * manager acts on hidden among them.
   *
   * Overdue's tone IS the destructive pair this used to hard-code, so that pill
   * does not move; it just stops being a special case.
   */
  tone?: PlanUnitStatus
  testId: string
}) {
  const toned = tone ? PLAN_TONE[tone] : null
  return (
    // Laid out as inline text, NOT as a flex row: flex would put the numeral
    // and the label in separate boxes with only a `gap` between them, which
    // looks spaced but reads as "1of 3 done" to anything consuming the text —
    // a screen reader, a copy-paste, an assertion. Inline flow gives a real
    // word space and the baseline alignment the design wants for free.
    <span
      data-testid={testId}
      className={`whitespace-nowrap rounded-full px-[11px] py-1 text-[12.5px] ${
        toned ? `${toned.bg} ${toned.text}` : "bg-muted text-muted-foreground"
      }`}
    >
      <b
        className={`me-0.5 text-sm font-semibold tabular-nums ${
          toned ? toned.text : "text-foreground"
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
  shortChaptersByUnit, assigneesByUnit, onOpenShortfall, laneLabel,
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
  /**
   * AQU-1278. Which chapters of a unit are still short, keyed by `planUnitId`
   * — the row draws them as "chapters 3, 9, 41".
   *
   * The board only ROUTES this; it never fetches it. The chapter detail comes
   * from a per-unit read, and a board that fired one of those per row would
   * open sixty-six requests to draw a plan nobody has scrolled to yet. The
   * owner (ProjectOverview) fetches for the rows it decides are worth it and
   * hands back a map, so a unit with no entry simply draws no chapter line.
   */
  shortChaptersByUnit?: ReadonlyMap<string, string[]>
  /**
   * AQU-1278. Who is working on each unit, keyed by `planUnitId`.
   *
   * Typed structurally rather than imported from `@/lib/sync/assignments`: the
   * board renders a name and keys by an id, and nothing else about an
   * assignment record is its business — so the assignment read can grow
   * fields without touching this signature.
   */
  assigneesByUnit?: ReadonlyMap<string, readonly { userId: number; username: string | null }[]>
  /**
   * AQU-1278. Open the editor at this unit's FIRST OUTSTANDING CELL — the one
   * link that turns "4 cells short" into work. Routed, not implemented: the
   * board has no idea where the editor lives or how a workspace is opened,
   * and ProjectOverview already owns both.
   */
  onOpenShortfall?: (unit: PlanUnit) => void
  /**
   * AQU-1278: the language whose numbers the board is showing, named beside
   * the heading. The lane tabs that choose it live in the Progress card a
   * screen above, so a reader standing at the board had no way to tell which
   * language they were reading without scrolling up. Null on a project with
   * one language, where there is nothing to tell apart.
   */
  laneLabel?: string | null
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
  const audioFiles = useMemo(() => audioFileIds(units), [units])
  // `audioFiles` comes from the UNFILTERED units and is handed in rather than
  // re-derived: see groupPlanUnits' own note on why a search box must not be
  // able to change which group a row is in.
  const groups = useMemo(
    () => groupPlanUnits(visible, now, audioFiles),
    [visible, now, audioFiles],
  )

  // AQU-1278: COLLAPSE ALL (Sam, 2026-09-17). One control, two states: it
  // reads "Collapse all" while any group on screen is open and "Expand all"
  // once every one is folded. It sets the same per-project folds the group
  // chevrons set, so a single chevron afterwards opens just that group and
  // nothing new is remembered. This is what AQU-1255's five-row cap was
  // reaching for — a board short enough to take in at once — and it gets there
  // without hiding a row: every header keeps its count.
  //
  // "All folded" is judged over the groups DRAWN, not over every status: a
  // project with no Done units has no Done group to fold, and a button that
  // never said "Expand all" because an absent group was "still open" would be
  // a button that never worked. Expanding clears the set outright, so a group
  // folded earlier and filtered away today comes back open too.
  const allFolded = groups.length > 0 && groups.every((g) => collapsed.has(g.status))
  const toggleAll = useCallback(() => {
    setCollapsed((prev) => {
      const next = allFolded
        ? new Set<PlanUnitStatus>()
        : new Set<PlanUnitStatus>([...prev, ...groups.map((g) => g.status)])
      saveCollapsedGroups(projectId, next)
      return next
    })
  }, [allFolded, groups, projectId])

  // The summary counts the WHOLE project, never the filtered view. "1 of 3
  // done" under a filter that hid the other sixty-three would be a lie, and
  // the strip is the one thing on this card a reader trusts without checking.
  const summary = useMemo(() => planSummary(units, now), [units, now])
  // Audio bars vanish entirely on a text-only project rather than showing a
  // column of zeroes, matching what the Progress card already does. Judged on
  // the whole project so a filter cannot make a column appear and disappear.
  const showAudio = useMemo(() => planHasAudio(units), [units])
  /**
   * AQU-1278: which FILES carry recordings. Computed ONCE over the whole board
   * and handed down, for two reasons that are both bugs if you skip it.
   *
   * A row left to judge audio from its own `audioCount` would call every
   * not-yet-recorded book of a dubbed whole-Bible file "text-only" and declare
   * it nearly complete on its text alone — the row and the group header would
   * then disagree about the same unit, since `groupPlanUnits` already judges
   * this per file across the board.
   *
   * And it is derived from `units`, never from `visible`: a filter that hid
   * the one recorded book must not change what the remaining rows MEAN.
   */

  /**
   * Every row on screen, in drawn order — which is also exactly what the arrow
   * keys walk. Anything filtered out or folded away is already gone.
   *
   * AQU-1255 used to cap this at the first five and offer a Show all button.
   * Sam removed it (2026-09-16): a manager opening the plan wants the plan, and
   * the per-group folds — which persist per project — are the honest way to see
   * less, because a fold says what it is hiding and a truncation does not.
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

  const renderRow = (unit: PlanUnit) => {
    const id = planUnitId(unit)
    return (
      <PlanRow
        key={id}
        unit={unit}
        now={now}
        showAudio={showAudio}
        audioFiles={audioFiles}
        // AQU-1278. Both maps are looked up HERE rather than passed whole: a
        // row handed the map would re-render whenever any other row's chapters
        // or assignees arrived, and on a sixty-six row board that is the whole
        // board re-rendering once per background read.
        shortChapters={shortChaptersByUnit?.get(id)}
        assignees={assigneesByUnit?.get(id)}
        // Bound to the unit here, exactly like `onSelect` below it, so a row
        // never has to know how a unit is addressed. Absent when the owner
        // supplied no handler, so the row can drop the link rather than render
        // a button that does nothing.
        onOpenShortfall={onOpenShortfall ? () => onOpenShortfall(unit) : undefined}
        // In Order mode no header above the row carries its status, so the row
        // carries it itself.
        showStatus={view === "order"}
        selected={id === selectedId}
        onSelect={() => onSelect(id)}
      />
    )
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid="plan-board">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-[17px] py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="me-1 text-xs font-semibold text-muted-foreground">
            {t("org.projectOverview.plan.heading")}
            {laneLabel && (
              <span className="font-normal" data-testid="plan-lane-label">
                {" \u00b7 "}
                {laneLabel}
              </span>
            )}
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
              tone="overdue"
              label={t("org.projectOverview.plan.summaryOverdueLabel", { count: summary.overdue })}
            />
          )}
          {/* AQU-1278. BEFORE the in-progress pill, not after it. The strip
              reads in urgency order like the groups below it do, and nearly
              complete is the more actionable number of the two: it is the one
              bucket a manager can actually empty this week. Its count comes
              out of `inFlight` rather than being added on top — the two pills
              must never describe the same unit twice. */}
          {summary.nearlyComplete > 0 && (
            <PlanStat
              testId="plan-summary-nearly-complete"
              value={summary.nearlyComplete}
              tone="nearly_complete"
              label={t("org.projectOverview.plan.summaryNearlyCompleteLabel", {
                count: summary.nearlyComplete,
              })}
            />
          )}
          {summary.inFlight > 0 && (
            <PlanStat
              testId="plan-summary-in-progress"
              value={summary.inFlight}
              tone="in_progress"
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
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {/* After the arrangement toggle, because it only means something
                while there are groups. In "In order" it dims rather than
                leaves, so the toolbar keeps its shape between the two. */}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-testid="plan-collapse-all"
              disabled={view === "order" || groups.length === 0}
              title={t(allFolded
                ? "org.projectOverview.plan.expandAllTooltip"
                : "org.projectOverview.plan.collapseAllTooltip")}
              onClick={toggleAll}
            >
              {allFolded
                ? <ChevronsUpDown className="h-3 w-3" />
                : <ChevronsDownUp className="h-3 w-3" />}
              {t(allFolded ? "org.projectOverview.plan.expandAll" : "org.projectOverview.plan.collapseAll")}
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
              {ordered.map(renderRow)}
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
                  {!folded && group.units.length > 0 && (
                    <ul className="divide-y">{group.units.map(renderRow)}</ul>
                  )}
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
