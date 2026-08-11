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
  startError: string | null,
  initialLoadFailed: boolean,
): PanelState {
  if (initialLoadFailed || startError) return "attention"
  if (starting || overview.files.some((file) => WORKING_STATUSES.has(file.status))) return "working"
  if (overview.files.some((file) => file.status === "failed")) return "attention"
  if (overview.files.some((file) => file.status === "paused")) return "paused"
  if (overview.files.some(fileHasQueuedWork)) return "queued"
  if (overview.files.some((file) => file.status === "parked")) return "idle"
  if (overview.proposedDrafts > 0) return "review"
  if (overview.files.some((file) => file.status === "done")) return "complete"
  if (overview.files.some((file) => file.status === "terminated")) return "stopped"
  return "not-started"
}

function stateLabel(state: PanelState): string {
  if (state === "attention") return "Needs attention"
  if (state === "working") return "Working"
  if (state === "paused") return "Paused"
  if (state === "queued") return "Queued"
  if (state === "idle") return "Idle"
  if (state === "review") return "Ready for review"
  if (state === "complete") return "Complete"
  if (state === "stopped") return "Stopped"
  return "Not started"
}

function StateBadge({ state }: { state: PanelState }) {
  return (
    <Badge variant={state === "attention" ? "destructive" : state === "working" ? "default" : state === "review" ? "secondary" : "outline"}>
      {state === "working" && <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden />}
      {state === "attention" && <AlertTriangle data-icon="inline-start" aria-hidden />}
      {state === "paused" && <CirclePause data-icon="inline-start" aria-hidden />}
      {state === "complete" && <CircleCheck data-icon="inline-start" aria-hidden />}
      {state === "stopped" && <Square data-icon="inline-start" aria-hidden />}
      {stateLabel(state)}
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
): string {
  if (state === "attention") {
    if (initialLoadFailed) return "Autopilot status couldn’t be loaded. Try again before starting new work."
    const count = countAttentionItems(overview.files)
    return count > 0
      ? `${count} ${count === 1 ? "issue needs" : "issues need"} attention. Open activity to see what happened.`
      : "Autopilot could not start. Check the message below, then try again."
  }
  if (starting) return "Scanning project files and starting work…"
  if (state === "working") {
    if (!workingTotalsKnown) {
      return `Working across ${workingFileCount} ${workingFileCount === 1 ? "file" : "files"} — scanning passages and starting the next steps…`
    }
    if (workingTotal > 0) return `Working across ${workingFileCount} ${workingFileCount === 1 ? "file" : "files"} — ${workingDone} of ${workingTotal} passages complete across the project’s latest runs.`
    return "Scanning passages and starting the next steps…"
  }
  if (state === "paused") {
    return workingTotal > 0 ? `Autopilot is paused at ${workingDone} of ${workingTotal} passages.` : "Autopilot is paused."
  }
  if (state === "queued") {
    const remaining = overview.files.reduce(
      (total, file) => total + (fileHasQueuedWork(file)
        ? file.totalSpans - file.doneSpans - file.failedSpans
        : 0),
      0,
    )
    return `${remaining} ${remaining === 1 ? "passage is" : "passages are"} queued. Autopilot will continue in the background.`
  }
  if (state === "idle") return "Current runs are idle. No more work is queued."
  if (state === "review") return `${overview.proposedDrafts} ${overview.proposedDrafts === 1 ? "draft is" : "drafts are"} ready for review.`
  if (state === "complete") return "Autopilot completed its latest run."
  if (state === "stopped") return "The latest Autopilot run was stopped."
  return "Ready to run — Autopilot hasn’t run on this project yet."
}

function formatChecked(value: Date | null): string {
  if (!value) return "Not checked yet"
  return `Checked ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(value)}`
}

function skippedReasonSummary(skipped: ProjectRunStartResult["skipped"]): string[] {
  const counts = new Map<string, number>()
  for (const item of skipped) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
  return [...counts].map(([reason, count]) => {
    const files = `${count} ${count === 1 ? "file" : "files"}`
    if (reason === "already running") return `${files} ${count === 1 ? "is" : "are"} already running`
    if (reason === "work queued") return `${files} still ${count === 1 ? "has" : "have"} queued work`
    if (reason === "paused") return `${files} ${count === 1 ? "is" : "are"} paused`
    if (reason === "pause pending") return `${files} ${count === 1 ? "is" : "are"} finishing a pause`
    if (reason === "idle run owns file; review or stop it before rerunning") {
      return `${files} ${count === 1 ? "has" : "have"} an idle run; review its drafts or stop it before rerunning`
    }
    if (reason === "start_failed") {
      return `${files} couldn’t start; open activity for details`
    }
    // Reasons are durable technical categories. Unknown future categories
    // must not leak raw identifiers or backend prose into the primary UI.
    return `${files} couldn’t start right now`
  })
}

function startResultSummary(result: ProjectRunStartResult): string {
  const started = result.started.length
  const skipped = result.skipped.length
  const deferred = result.deferred.count
  const parts = [started > 0
    ? `${started} ${started === 1 ? "file" : "files"} started`
    : "No files started"]
  if (skipped > 0) parts.push(`${skipped} skipped`)
  if (deferred > 0) parts.push(`${deferred} deferred to the next batch`)
  const outcome = `${parts.join(" · ")}.`
  const reasons = skippedReasonSummary(result.skipped)
  const why = reasons.length > 0 ? ` ${reasons.join("; ")}.` : ""
  const continuation = deferred > 0
    ? " Run Autopilot again after this batch becomes idle to start the waiting files."
    : ""
  return `${outcome}${why}${continuation} Draft suggestions stay in review until a person accepts them.`
}

function ActionWidget({
  label,
  count,
  onClick,
}: {
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto min-w-0 justify-between whitespace-normal px-3 py-2 text-left"
      aria-label={`View ${count} ${label.toLowerCase()}`}
      onClick={onClick}
    >
      <span className="min-w-0"><span className="block text-lg font-semibold tabular-nums">{count}</span><span className="block text-xs text-muted-foreground">{label}</span></span>
      <ChevronRight data-icon="inline-end" aria-hidden />
    </Button>
  )
}

export function ProjectAutopilotPanel({ projectId, fileNames, canStart }: ProjectAutopilotPanelProps) {
  const [overview, setOverview] = useState<ContextualOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [startSummary, setStartSummary] = useState<string | null>(null)
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
    setStartError(null)
    setStartSummary(null)
    try {
      const result = await startProjectContextualRun(projectId)
      setStartSummary(startResultSummary(result))
      await load()
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Autopilot could not start.")
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
  const state = resolveState(overview, starting, startError, initialLoadFailed)
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
            <h3>Autopilot</h3>
            <StateBadge state={state} />
          </CardTitle>
          <CardDescription>{primaryLine(state, overview, workingDone, workingTotal, workingFileCount, workingTotalsKnown, starting, initialLoadFailed)}</CardDescription>
          {showStart && (
            <CardAction>
              <Button type="button" size="sm" variant={state === "not-started" ? "default" : "outline"} disabled={starting} onClick={() => void handleStart()}>
                {starting ? <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Play data-icon="inline-start" aria-hidden />}
                Run Autopilot
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {starting && <p role="status" aria-live="polite" className="text-sm font-medium">Starting Autopilot…</p>}
          {state === "working" && !starting && workingTotalsKnown && workingTotal > 0 && (
            <Progress value={(workingDone / workingTotal) * 100} aria-label={`${workingDone} of ${workingTotal} passages complete`} />
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <ActionWidget label="Ready to review" count={overview.proposedDrafts} onClick={() => openInspector("review")} />
            <ActionWidget label="Needs attention" count={attentionItems} onClick={() => openInspector("attention")} />
            <ActionWidget label="Context suggestions" count={suggestionCount} onClick={() => openInspector("context")} />
          </div>
          {startSummary && !starting && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{startSummary}</p>}
          {startError && <p role="alert" className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{startError}</p>}
          {refreshWarning && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="status">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span>{lastGoodAt ? `Refresh failed. Showing the snapshot checked at ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(lastGoodAt)}.` : "Autopilot status could not be loaded."}</span>
              <Button type="button" size="xs" variant="ghost" onClick={() => void load()}>Try again</Button>
            </div>
          )}
        </CardContent>
        <CardFooter className="justify-between gap-3">
          <span className="text-xs text-muted-foreground">{formatChecked(lastGoodAt)}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => openInspector("activity")}>
            View activity
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
