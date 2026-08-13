import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ChevronRight,
  CircleCheck,
  CirclePause,
  LoaderCircle,
  Play,
  Sparkles,
  Square,
} from "lucide-react"
import { AutopilotActivityInspector, type AutopilotInspectorSection } from "@/components/contextual/AutopilotActivityInspector"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  fetchContextualOverview,
  startProjectContextualRun,
  type ContextualOverview,
  type ContextualOverviewFile,
  type ProjectRunStartResult,
} from "@/lib/contextual/transport"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"

const POLL_MS = 4_000
const WORKING_STATUSES = new Set(["running", "pausing"])

interface ProjectAutopilotPanelProps {
  projectId: string
  fileNames: Map<string, string>
  canStart: boolean
}

type PanelState =
  | "attention"
  | "working"
  | "paused"
  | "queued"
  | "idle"
  | "review"
  | "complete"
  | "stopped"
  | "not-started"

const EMPTY: ContextualOverview = {
  available: false,
  files: [],
  activeRuns: 0,
  doneSpans: 0,
  totalSpans: 0,
  failedSpans: 0,
  unitsSpent: 0,
  proposedDrafts: 0,
  appliedDrafts: 0,
}

function countAttentionItems(files: ContextualOverviewFile[]): number {
  return files.reduce(
    (total, file) => total + Math.max(file.failedSpans, file.status === "failed" || file.lastError ? 1 : 0),
    0,
  )
}

function fileHasQueuedWork(file: ContextualOverviewFile): boolean {
  return file.status === "parked" && file.totalSpans > file.doneSpans + file.failedSpans
}

function resolveState(
  overview: ContextualOverview,
  starting: boolean,
  startFailed: boolean,
  initialLoadFailed: boolean,
): PanelState {
  if (initialLoadFailed || startFailed) return "attention"
  if (starting || overview.files.some((file) => WORKING_STATUSES.has(file.status))) return "working"
  if (overview.files.some((file) => file.status === "failed")) return "attention"
  if (overview.files.some((file) => file.status === "parked" && file.failedSpans > 0 && !fileHasQueuedWork(file))) return "attention"
  if (overview.files.some((file) => file.status === "paused")) return "paused"
  if (overview.files.some(fileHasQueuedWork)) return "queued"
  if (overview.files.some((file) => file.status === "parked")) return "idle"
  if (overview.proposedDrafts > 0) return "review"
  if (overview.files.some((file) => file.status === "done")) return "complete"
  if (overview.files.some((file) => file.status === "terminated")) return "stopped"
  return "not-started"
}

function stateLabel(state: PanelState, t: TFunction): string {
  if (state === "attention") return t("autopilot.status.needsAttention")
  if (state === "working") return t("autopilot.status.working")
  if (state === "paused") return t("autopilot.status.paused")
  if (state === "queued") return t("autopilot.status.queued")
  if (state === "idle") return t("autopilot.status.idle")
  if (state === "review") return t("autopilot.status.readyForReview")
  if (state === "complete") return t("autopilot.status.complete")
  if (state === "stopped") return t("autopilot.status.stopped")
  return t("autopilot.status.notStarted")
}

function StateBadge({ state, t }: { state: PanelState; t: TFunction }) {
  return (
    <Badge variant={state === "attention" ? "destructive" : state === "working" ? "default" : state === "review" ? "secondary" : "outline"}>
      {state === "working" && <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {state === "attention" && <AlertTriangle data-icon="inline-start" aria-hidden />}
      {state === "paused" && <CirclePause data-icon="inline-start" aria-hidden />}
      {state === "complete" && <CircleCheck data-icon="inline-start" aria-hidden />}
      {state === "stopped" && <Square data-icon="inline-start" aria-hidden />}
      {stateLabel(state, t)}
    </Badge>
  )
}

function primaryLine(
  state: PanelState,
  overview: ContextualOverview,
  workingDone: number,
  workingTotal: number,
  workingFileCount: number,
  workingTotalsKnown: boolean,
  starting: boolean,
  initialLoadFailed: boolean,
  t: TFunction,
): string {
  if (state === "attention") {
    if (initialLoadFailed) return t("autopilot.overview.loadFailed")
    const count = countAttentionItems(overview.files)
    return count > 0
      ? t("autopilot.overview.attentionIssues", { count })
      : t("autopilot.overview.startFailedHelp")
  }
  if (starting) return t("autopilot.overview.startingScan")
  if (state === "working") {
    if (!workingTotalsKnown) {
      return t("autopilot.overview.workingScanningFiles", { fileCount: workingFileCount })
    }
    if (workingTotal > 0) {
      return t("autopilot.overview.workingProgress", {
        fileCount: workingFileCount,
        progress: t("autopilot.overview.passagesProgress", {
          done: workingDone,
          total: workingTotal,
        }),
      })
    }
    return t("autopilot.overview.scanningPassages")
  }
  if (state === "paused") {
    return workingTotal > 0
      ? t("autopilot.overview.pausedProgress", { done: workingDone, total: workingTotal })
      : t("autopilot.overview.paused")
  }
  if (state === "queued") {
    const remaining = overview.files.reduce(
      (total, file) => total + (fileHasQueuedWork(file)
        ? file.totalSpans - file.doneSpans - file.failedSpans
        : 0),
      0,
    )
    return t("autopilot.overview.queuedPassages", { count: remaining })
  }
  if (state === "idle") return t("autopilot.overview.idle")
  if (state === "review") return t("autopilot.overview.reviewDrafts", { count: overview.proposedDrafts })
  if (state === "complete") return t("autopilot.overview.complete")
  if (state === "stopped") return t("autopilot.overview.stopped")
  return t("autopilot.overview.notStarted")
}

function formatChecked(value: Date | null, locale: string, t: TFunction): string {
  if (!value) return t("autopilot.time.checkedNever")
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(value)
  return t("autopilot.time.checkedAt", { time })
}

function skippedReasonSummary(
  skipped: ProjectRunStartResult["skipped"],
  t: TFunction,
): string[] {
  const counts = new Map<string, number>()
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
  return [...counts].map(([reason, count]) => {
    if (reason === "already running") return t("autopilot.overview.startResult.alreadyRunning", { count })
    if (reason === "work queued") return t("autopilot.overview.startResult.queuedWork", { count })
    if (reason === "paused") return t("autopilot.overview.startResult.paused", { count })
    if (reason === "pause pending") return t("autopilot.overview.startResult.pausePending", { count })
    if (reason === "idle run owns file; review or stop it before rerunning") {
      return t("autopilot.overview.startResult.idleOwner", { count })
    }
    if (reason === "start_failed") {
      return t("autopilot.overview.startResult.startFailed", { count })
    }
    // Reasons are durable technical categories. Unknown future categories
    // must not leak raw identifiers or backend prose into the primary UI.
    return t("autopilot.overview.startResult.unavailable", { count })
  })
}

function formatList(items: string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items)
}

function startResultSummary(result: ProjectRunStartResult, locale: string, t: TFunction): string {
  const started = result.started.length
  const skipped = result.skipped.length
  const deferred = result.deferred.count
  const parts = [started > 0
    ? t("autopilot.overview.startResult.startedFiles", { count: started })
    : t("autopilot.overview.startResult.noneStarted")]
  if (skipped > 0) parts.push(t("autopilot.overview.startResult.skippedFiles", { count: skipped }))
  if (deferred > 0) parts.push(t("autopilot.overview.startResult.deferredFiles", { count: deferred }))
  const outcome = t("autopilot.overview.startResult.outcome", { items: formatList(parts, locale) })
  const reasons = skippedReasonSummary(result.skipped, t)
  const why = reasons.length > 0
    ? t("autopilot.overview.startResult.outcome", { items: formatList(reasons, locale) })
    : null
  const continuation = deferred > 0
    ? t("autopilot.overview.startResult.deferredHelp")
    : null
  return [outcome, why, continuation, t("autopilot.overview.startResult.reviewGuarantee")]
    .filter((part): part is string => part !== null)
    .join(" ")
}

function ActionWidget({
  label,
  ariaLabel,
  count,
  onClick,
}: {
  label: string
  ariaLabel: string
  count: number
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-w-0 justify-between whitespace-normal px-3 py-2 text-left"
      aria-label={ariaLabel}
      onClick={onClick}
    >
      <span className="min-w-0"><span className="block text-lg font-semibold tabular-nums">{count}</span><span className="block text-xs text-muted-foreground">{label}</span></span>
      <ChevronRight data-icon="inline-end" aria-hidden />
    </Button>
  )
}

export function ProjectAutopilotPanel({ projectId, fileNames, canStart }: ProjectAutopilotPanelProps) {
  const { locale, t } = useI18n()
  const [overview, setOverview] = useState<ContextualOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [startFailed, setStartFailed] = useState(false)
  const [startResult, setStartResult] = useState<ProjectRunStartResult | null>(null)
  const [refreshWarning, setRefreshWarning] = useState(false)
  const [lastGoodAt, setLastGoodAt] = useState<Date | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorSection, setInspectorSection] = useState<AutopilotInspectorSection>("activity")
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const next = await fetchContextualOverview(projectId)
      if (seq !== seqRef.current) return
      setOverview(next)
      setLastGoodAt(new Date())
      setRefreshWarning(false)
    } catch {
      if (seq !== seqRef.current) return
      setRefreshWarning(true)
      // Keep a visible recovery surface on a transient first-load failure.
      // Explicit 404/501 capability responses still arrive as
      // `{ available:false }` and continue to hide an undeployed feature.
      setOverview((current) => current ?? { ...EMPTY, available: true })
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const shouldPoll = useMemo(
    () => (overview?.files ?? []).some((file) => WORKING_STATUSES.has(file.status) || fileHasQueuedWork(file)),
    [overview],
  )

  useEffect(() => {
    if (!shouldPoll) return
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [load, shouldPoll])

  const openInspector = (section: AutopilotInspectorSection) => {
    setInspectorSection(section)
    setInspectorOpen(true)
  }

  const handleInspectorOpenChange = (nextOpen: boolean) => {
    setInspectorOpen(nextOpen)
    // Paused/idle runs intentionally do not poll. Closing the control surface
    // is therefore an explicit reconciliation point for the compact card.
    if (!nextOpen) void load()
  }

  const handleStart = async () => {
    if (starting) return
    setStarting(true)
    setStartFailed(false)
    setStartResult(null)
    try {
      const result = await startProjectContextualRun(projectId)
      setStartResult(result)
      await load()
    } catch {
      setStartFailed(true)
    } finally {
      setStarting(false)
    }
  }

  if (loading && !overview) {
    return (
      <Card size="sm" className="mt-6" data-testid="project-autopilot-loading">
        <CardHeader><Skeleton className="h-5 w-28" /><Skeleton className="h-4 w-64 max-w-full" /></CardHeader>
        <CardContent><Skeleton className="h-14 w-full" /></CardContent>
      </Card>
    )
  }
  if (!overview?.available) return null

  const initialLoadFailed = refreshWarning && lastGoodAt === null
  const state = resolveState(overview, starting, startFailed, initialLoadFailed)
  const progressFiles = overview.files.filter((file) =>
    state === "working" ? WORKING_STATUSES.has(file.status) : state === "paused" && file.status === "paused",
  )
  const workingTotalsKnown = state !== "working"
    || (progressFiles.length > 0 && progressFiles.every((file) => file.totalSpans > 0))
  // Once every executing row has been segmented, use the server's project
  // aggregate. It includes newest sibling runs that just completed, so the
  // denominator cannot shrink merely because a file left `running`.
  const workingDone = state === "working" && workingTotalsKnown
    ? overview.doneSpans
    : progressFiles.reduce((total, file) => total + file.doneSpans, 0)
  const workingTotal = state === "working" && workingTotalsKnown
    ? overview.totalSpans
    : progressFiles.reduce((total, file) => total + file.totalSpans, 0)
  const workingFileCount = new Set(progressFiles.map((file) => file.fileId)).size
  const attentionItems = countAttentionItems(overview.files)
  const suggestionCount = overview.readiness?.items.filter((item) => item.level !== "ready").length ?? 0
  const hasBlockingRun = overview.files.some((file) =>
    WORKING_STATUSES.has(file.status) || file.status === "paused" || fileHasQueuedWork(file),
  )
  const showStart = canStart && !initialLoadFailed && (starting || !hasBlockingRun)

  return (
    <>
      <Card size="sm" className="mt-6" data-testid="project-autopilot-panel">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <h3>{t("autopilot.name")}</h3>
            <StateBadge state={state} t={t} />
          </CardTitle>
          <CardDescription>{primaryLine(state, overview, workingDone, workingTotal, workingFileCount, workingTotalsKnown, starting, initialLoadFailed, t)}</CardDescription>
          {showStart && (
            <CardAction>
              <Button type="button" size="sm" variant={state === "not-started" ? "default" : "outline"} disabled={starting} onClick={() => void handleStart()}>
                {starting ? <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play data-icon="inline-start" aria-hidden />}
                {t("autopilot.action.run")}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {starting && <p role="status" aria-live="polite" className="text-sm font-medium">{t("autopilot.feedback.starting")}</p>}
          {state === "working" && !starting && workingTotalsKnown && workingTotal > 0 && (
            <Progress
              value={(workingDone / workingTotal) * 100}
              aria-label={t("autopilot.progress.passagesComplete", { done: workingDone, total: workingTotal })}
            />
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <ActionWidget
              label={t("autopilot.overview.widget.reviewLabel")}
              ariaLabel={t("autopilot.overview.widget.reviewAria", { count: overview.proposedDrafts })}
              count={overview.proposedDrafts}
              onClick={() => openInspector("review")}
            />
            <ActionWidget
              label={t("autopilot.status.needsAttention")}
              ariaLabel={t("autopilot.overview.widget.attentionAria", { count: attentionItems })}
              count={attentionItems}
              onClick={() => openInspector("attention")}
            />
            <ActionWidget
              label={t("autopilot.overview.widget.contextLabel")}
              ariaLabel={t("autopilot.overview.widget.contextAria", { count: suggestionCount })}
              count={suggestionCount}
              onClick={() => openInspector("context")}
            />
          </div>
          {startResult && !starting && (
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              {startResultSummary(startResult, locale, t)}
            </p>
          )}
          {startFailed && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{t("autopilot.error.startFailed")}</p>}
          {refreshWarning && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="status">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span>{lastGoodAt
                ? t("autopilot.overview.refreshFailedAt", {
                    time: new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(lastGoodAt),
                  })
                : t("autopilot.overview.refreshFailedInitial")}</span>
              <Button type="button" size="xs" variant="ghost" onClick={() => void load()}>{t("common.retry")}</Button>
            </div>
          )}
        </CardContent>
        <CardFooter className="justify-between gap-3">
          <span className="text-xs text-muted-foreground">{formatChecked(lastGoodAt, locale, t)}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => openInspector("activity")}>
            {t("autopilot.action.viewActivity")}
            <ChevronRight data-icon="inline-end" aria-hidden />
          </Button>
        </CardFooter>
      </Card>
      <AutopilotActivityInspector
        projectId={projectId}
        open={inspectorOpen}
        onOpenChange={handleInspectorOpenChange}
        onRunChanged={load}
        fileNames={fileNames}
        overview={overview}
        readiness={overview.readiness}
        initialSection={inspectorSection}
        canControl={canStart}
      />
    </>
  )
}
