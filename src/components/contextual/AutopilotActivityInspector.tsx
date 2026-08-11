import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  ChevronDown,
  Clipboard,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Square,
} from "lucide-react"
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { defaultLaneDraftReviewHref } from "@/components/project-workspace-lane-deeplink"
import {
  commandContextualRun,
  fetchContextualRunActivity,
  fetchContextualRuns,
  startFileContextualRun,
  type ContextReadiness,
  type ContextualActivityDraft,
  type ContextualActivityEvent,
  type ContextualActivitySceneBrief,
  type ContextualDraftCursor,
  type ContextualOverview,
  type ContextualRunActivity,
  type ContextualRunActivityOptions,
  type ContextualRunCommand,
  type ContextualRunCursor,
  type ContextualRunListOptions,
  type ContextualRunRecord,
} from "@/lib/contextual/transport"

const POLL_MS = 4_000
const DRAFT_PAGE_SIZE = 50
const WORKING_STATUSES = new Set(["running", "pausing"])

export type AutopilotInspectorSection = "activity" | "review" | "attention" | "context"

export interface AutopilotActivityInspectorProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  fileNames?: ReadonlyMap<string, string>
  overview?: ContextualOverview | null
  readiness?: ContextReadiness
  focusRunId?: string | null
  focusFileId?: string | null
  fallbackRun?: ContextualRunRecord | null
  initialSection?: AutopilotInspectorSection
  canControl?: boolean
  /** Lets a parent overview refresh immediately after a guarded mutation. */
  onRunChanged?: () => void | Promise<void>
}

function runHasQueuedWork(run: ContextualRunRecord): boolean {
  return run.status === "parked" && run.total > run.done + run.failed
}

function runFromOverview(row: ContextualOverview["files"][number]): ContextualRunRecord {
  return {
    runId: row.runId,
    fileId: row.fileId,
    status: row.status,
    phase: null,
    spanLabel: null,
    done: row.doneSpans,
    total: row.totalSpans,
    failed: row.failedSpans,
    unitsSpent: row.unitsSpent,
    callsSpent: 0,
    lastError: row.lastError,
    createdAt: "",
    updatedAt: row.updatedAt,
    activeDirections: [],
    proposedDrafts: row.proposedDrafts,
    targetLang: row.targetLang,
  }
}

function statusLabel(run: ContextualRunRecord): string {
  if (run.status === "failed") return "Needs attention"
  if (run.status === "running" || run.status === "pausing") return "Working"
  if (run.status === "paused") return "Paused"
  if (run.status === "parked") return runHasQueuedWork(run) ? "Queued" : "Idle"
  if (run.status === "done") return "Complete"
  if (run.status === "terminated") return "Stopped"
  return "Not started"
}

function StatusBadge({ run }: { run: ContextualRunRecord }) {
  const label = statusLabel(run)
  const variant = label === "Needs attention" ? "destructive" : label === "Working" ? "default" : "outline"
  return (
    <Badge variant={variant}>
      {label === "Working" && (
        <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden />
      )}
      {label === "Needs attention" && <AlertTriangle data-icon="inline-start" aria-hidden />}
      {label}
    </Badge>
  )
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Not recorded"
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return "Not recorded"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function humanizeKind(kind: string): string {
  return kind.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function preferredRun(runs: ContextualRunRecord[], section: AutopilotInspectorSection) {
  if (section === "attention") {
    const failed = runs.find((run) => run.status === "failed" || run.lastError)
    if (failed) return failed
  }
  if (section === "review") {
    const review = runs.find(
      (run) => !run.targetLang && (run.proposedDrafts ?? 0) > 0,
    )
    if (review) return review
  }
  return runs.find((run) => WORKING_STATUSES.has(run.status) || runHasQueuedWork(run)) ?? runs[0] ?? null
}

function mergeRuns(primary: ContextualRunRecord[], fallback: ContextualRunRecord[]) {
  const byId = new Map(fallback.map((run) => [run.runId, run]))
  const mergedPrimary = primary.map((run) => {
    const merged = { ...byId.get(run.runId), ...run }
    byId.delete(run.runId)
    return merged
  })
  return [...mergedPrimary, ...byId.values()]
}

function mergeDrafts(primary: ContextualActivityDraft[], fallback: ContextualActivityDraft[]) {
  const fallbackById = new Map(
    fallback.map((draft, index) => [draft.id ?? `fallback-${index}`, draft]),
  )
  const mergedPrimary = primary.map((draft, index) => {
    const key = draft.id ?? `primary-${index}`
    const merged = { ...fallbackById.get(key), ...draft }
    fallbackById.delete(key)
    return merged
  })
  return [...mergedPrimary, ...fallbackById.values()]
}

function mergeRefreshedDrafts(
  loaded: ContextualActivityDraft[],
  fresh: ContextualActivityDraft[],
) {
  const freshById = new Map(
    fresh.map((draft, index) => [draft.id ?? `fresh-${index}`, draft]),
  )
  const retained = loaded.map((draft, index) => {
    const key = draft.id ?? `loaded-${index}`
    const next = freshById.get(key)
    freshById.delete(key)
    return next ? { ...draft, ...next } : draft
  })
  return [...retained, ...freshById.values()]
}

function authoritativeDraftCount(
  activity: ContextualRunActivity,
  section: AutopilotInspectorSection,
): number | null {
  if (!activity.draftCounts) return null
  if (section === "review") return activity.draftCounts.proposed
  return activity.draftCounts.proposed
    + activity.draftCounts.applied
    + activity.draftCounts.rejected
    + activity.draftCounts.superseded
}

function humanRunError(run: ContextualRunRecord): string | null {
  if (!run.lastError) return null
  if (run.lastError.includes("unsupported_target_language_lane")) {
    return "This run targets a multilingual lane that Autopilot doesn’t support yet. Its history is available, but it can’t be retried."
  }
  if (/provider_request_aborted\b/i.test(run.lastError)) {
    return "The model request ended before it completed. Retry when you’re ready."
  }
  if (/provider_transport_error\b/i.test(run.lastError)) {
    return "Autopilot couldn’t reach the model service. Check the connection, then try again."
  }
  if (/provider_invalid_response(?:\s+status=\d+)?/i.test(run.lastError)) {
    return "The model service returned a response Autopilot couldn’t use. Try again, or inspect Technical & evidence for diagnostics."
  }
  if (/provider_http_error(?:\s+status=\d+)?/i.test(run.lastError)) {
    return "The model service couldn’t complete this run. Try again later, or open Technical & evidence for diagnostic details."
  }
  if (/span_partial_cells_skipped\b/i.test(run.lastError)) {
    return "Some cells could not be drafted. Any completed suggestions were preserved for review; inspect the activity evidence before retrying."
  }
  if (/span_all_cells_skipped\b/i.test(run.lastError)) {
    return "Autopilot could not produce a reviewable draft for this passage. Inspect the activity evidence before retrying."
  }
  return run.lastError
}

function Disclosure({
  title,
  open,
  onOpenChange,
  badge,
  children,
}: {
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="flex flex-col gap-2">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="w-full justify-start" aria-expanded={open}>
          <ChevronDown
            data-icon="inline-start"
            className={cn("transition-transform motion-reduce:transition-none", !open && "-rotate-90")}
            aria-hidden
          />
          {title}
          {badge && <span className="ml-auto">{badge}</span>}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 px-2 pb-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const field = document.createElement("textarea")
  field.value = value
  field.style.position = "fixed"
  field.style.opacity = "0"
  document.body.append(field)
  field.select()
  document.execCommand("copy")
  field.remove()
}

function redactedDetails(value: unknown, key = ""): unknown {
  if (/authorization|cookie|token|secret|api.?key|prompt|completion/i.test(key)) return "[redacted]"
  if (Array.isArray(value)) return value.map((item) => redactedDetails(item))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactedDetails(child, childKey),
      ]),
    )
  }
  return value
}

function activityLog(run: ContextualRunRecord, activity: ContextualRunActivity | null): string {
  return JSON.stringify({
    run: {
      runId: run.runId,
      projectId: activity?.events[0]?.projectId,
      fileId: run.fileId,
      status: run.status,
      done: run.done,
      total: run.total,
      failed: run.failed,
      callsSpent: run.callsSpent,
      unitsSpent: run.unitsSpent,
      lastError: run.lastError,
      initiatedBy: run.initiatedBy,
      scopeGroup: run.scopeGroup,
      anchorCellId: run.anchorCellId,
      targetLang: run.targetLang,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    events: (activity?.events ?? []).map((event) => ({
      ...event,
      details: redactedDetails(event.details),
    })),
    truncated: activity?.truncated ?? false,
    truncatedCollections: activity?.truncatedCollections,
  }, null, 2)
}

function RunControls({
  run,
  busy,
  canControl,
  onCommand,
  onRetry,
}: {
  run: ContextualRunRecord
  busy: string | null
  canControl: boolean
  onCommand: (command: ContextualRunCommand) => void
  onRetry: () => void
}) {
  if (!canControl) return null
  return (
    <div className="flex flex-wrap gap-2">
      {run.status === "running" && !run.targetLang && (
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onCommand("pause")}>
          <Pause data-icon="inline-start" aria-hidden />
          Pause
        </Button>
      )}
      {run.status === "paused" && !run.targetLang && (
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onCommand("resume")}>
          <Play data-icon="inline-start" aria-hidden />
          Resume
        </Button>
      )}
      {["running", "pausing", "paused", "parked"].includes(run.status) && (
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onCommand("terminate")}>
          <Square data-icon="inline-start" aria-hidden />
          Stop
        </Button>
      )}
      {run.status === "failed" && !run.targetLang && (
        <Button type="button" size="sm" disabled={busy !== null} onClick={onRetry}>
          <Play data-icon="inline-start" aria-hidden />
          Run Autopilot
        </Button>
      )}
    </div>
  )
}

function EventTimeline({ events }: { events: ContextualActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Detailed step history wasn&apos;t recorded for this run. Its durable status and totals are still shown above.
      </p>
    )
  }
  return (
    <ol role="log" aria-live="off" aria-label="Autopilot step history" className="flex flex-col gap-3">
      {events.map((event) => (
        <li key={event.id} className="flex gap-3">
          <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{humanizeKind(event.kind)}</Badge>
              {(event.phase || event.status) && (
                <Badge variant="secondary">{event.phase ?? event.status}</Badge>
              )}
              <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                {formatTimestamp(event.createdAt)}
              </time>
            </div>
            <p className="mt-1 text-sm">{event.summary}</p>
            {event.spanLabel && <p className="text-xs text-muted-foreground">{event.spanLabel}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}

function ReviewDraft({
  draft,
  projectId,
  runTargetLang,
}: {
  draft: ContextualActivityDraft
  projectId: string
  runTargetLang?: string
}) {
  const provenance = draft.provenance && Object.keys(draft.provenance).length > 0
    ? JSON.stringify(draft.provenance)
    : "No provenance metadata recorded"
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{draft.cellId ? `Cell ${draft.cellId}` : "Draft"}</CardTitle>
        <CardDescription>{provenance}</CardDescription>
        <CardAction><Badge variant="outline">{draft.status ?? "unknown"}</Badge></CardAction>
      </CardHeader>
      {draft.text && <CardContent><p className="whitespace-pre-wrap">{draft.text}</p></CardContent>}
      {draft.status === "proposed" && draft.fileId && !runTargetLang && (
        <CardFooter>
          <a
            href={defaultLaneDraftReviewHref(projectId, draft.fileId, draft.cellId)}
            aria-label={`Review in editor${draft.cellId ? `: cell ${draft.cellId}` : ""}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Review in editor
          </a>
        </CardFooter>
      )}
      {draft.status === "proposed" && runTargetLang && (
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            Evidence only — this draft belongs to the unsupported {runTargetLang} lane and can’t be applied from Autopilot.
          </p>
        </CardFooter>
      )}
    </Card>
  )
}

function SceneBriefEvidence({ brief }: { brief: ContextualActivitySceneBrief }) {
  const ambiguities = Array.isArray(brief.ambiguityRegister) ? brief.ambiguityRegister : []
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{brief.startCellId && brief.endCellId ? `${brief.startCellId} → ${brief.endCellId}` : "Scene brief"}</CardTitle>
        <CardDescription>{brief.l1Summary ?? "No condensed scene summary was recorded."}</CardDescription>
        {brief.status && <CardAction><Badge variant="outline">{brief.status}</Badge></CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {brief.construal && (
          <div>
            <p className="text-xs font-medium">Construal</p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{brief.construal}</p>
          </div>
        )}
        <div>
          <p className="text-xs font-medium">Ambiguities ({ambiguities.length})</p>
          {ambiguities.length > 0 ? (
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
              {ambiguities.map((item, index) => <li key={item.id ?? index}>{item.question ?? "Unlabelled ambiguity"}</li>)}
            </ul>
          ) : <p className="text-sm text-muted-foreground">None recorded.</p>}
        </div>
      </CardContent>
    </Card>
  )
}

export function AutopilotActivityInspector({
  projectId,
  open,
  onOpenChange,
  fileNames,
  overview,
  readiness = overview?.readiness,
  focusRunId,
  focusFileId,
  fallbackRun,
  initialSection = "activity",
  canControl = false,
  onRunChanged,
}: AutopilotActivityInspectorProps) {
  const fallbackRuns = useMemo(() => mergeRuns(
    fallbackRun ? [fallbackRun] : [],
    (overview?.files ?? []).map(runFromOverview),
  ), [fallbackRun, overview])
  const [runs, setRuns] = useState<ContextualRunRecord[]>(fallbackRuns)
  const [runsTruncated, setRunsTruncated] = useState(false)
  const [nextRunCursor, setNextRunCursor] = useState<ContextualRunCursor | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(focusRunId ?? null)
  const [activity, setActivity] = useState<ContextualRunActivity | null>(null)
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [loadingOlderRuns, setLoadingOlderRuns] = useState(false)
  const [loadingActivity, setLoadingActivity] = useState(false)
  const [loadingOlderDrafts, setLoadingOlderDrafts] = useState(false)
  const [runsWarning, setRunsWarning] = useState<string | null>(null)
  const [activityWarning, setActivityWarning] = useState<string | null>(null)
  const [latestStepAnnouncement, setLatestStepAnnouncement] = useState("")
  const [detailsOpen, setDetailsOpen] = useState(initialSection === "attention")
  const [reviewOpen, setReviewOpen] = useState(initialSection === "review")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(initialSection === "context")
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const seqRef = useRef(0)
  const activitySeqRef = useRef(0)
  const activityRef = useRef<ContextualRunActivity | null>(null)
  const activityRunRef = useRef<string | null>(null)
  const pagedDraftRunRef = useRef<string | null>(null)
  const pagedRunHistoryRef = useRef(false)
  const nextRunCursorRef = useRef<ContextualRunCursor | null>(null)
  const runsRef = useRef<ContextualRunRecord[]>(fallbackRuns)
  const selectedRunRef = useRef<string | null>(focusRunId ?? null)
  const openSessionRef = useRef(false)
  // `focusRunId` is an opening hint. Explicit run clicks and retries must win
  // over it for the rest of this Sheet session.
  const selectionOverrideRef = useRef<string | null>(null)

  const scopedRuns = useMemo(
    () => focusFileId ? runs.filter((run) => run.fileId === focusFileId) : runs,
    [focusFileId, runs],
  )
  const selectedRun = scopedRuns.find((run) => run.runId === selectedRunId)
    ?? preferredRun(scopedRuns, initialSection)

  useEffect(() => {
    selectedRunRef.current = selectedRun?.runId ?? null
  }, [selectedRun?.runId])

  const loadRuns = useCallback(async () => {
    const seq = ++seqRef.current
    setLoadingRuns(true)
    try {
      const page = await fetchContextualRuns(projectId)
      if (seq !== seqRef.current) return
      let fetchedRuns = page.runs
      const shouldFindReviewOwner = initialSection === "review" && (overview?.proposedDrafts ?? 0) > 0
      const hasScopedReviewOwner = fetchedRuns.some(
        (run) => (!focusFileId || run.fileId === focusFileId) &&
          !run.targetLang &&
          (run.proposedDrafts ?? 0) > 0,
      )
      // A project-wide review count is authoritative across all durable runs,
      // while normal history is intentionally bounded. Ask the server's
      // indexed evidence-owner view rather than walking every history page.
      if (shouldFindReviewOwner && !hasScopedReviewOwner) {
        const reviewPage = await fetchContextualRuns(projectId, { proposedOnly: true })
        if (seq !== seqRef.current) return
        fetchedRuns = mergeRuns(fetchedRuns, reviewPage.runs)
      }
      const retainedCursor = pagedRunHistoryRef.current
        ? nextRunCursorRef.current
        : page.nextCursor
      nextRunCursorRef.current = retainedCursor
      setNextRunCursor(retainedCursor)
      setRunsTruncated((current) => pagedRunHistoryRef.current
        ? current
        : page.truncated || page.nextCursor !== null)
      const optimisticSelection = selectionOverrideRef.current
        ? runsRef.current.filter((run) => run.runId === selectionOverrideRef.current)
        : []
      const loadedHistory = pagedRunHistoryRef.current ? runsRef.current : []
      const next = mergeRuns(
        fetchedRuns,
        mergeRuns(optimisticSelection, mergeRuns(loadedHistory, fallbackRuns)),
      )
      runsRef.current = next
      setRuns(next)
      const scoped = focusFileId ? next.filter((run) => run.fileId === focusFileId) : next
      setSelectedRunId((current) => {
        const explicit = selectionOverrideRef.current
        if (explicit && scoped.some((run) => run.runId === explicit)) return explicit
        if (initialSection === "review") {
          const currentRun = scoped.find((run) => run.runId === current)
          const withReview = preferredRun(scoped, "review")
          if (
            withReview &&
            (currentRun?.targetLang || (currentRun?.proposedDrafts ?? 0) === 0) &&
            !withReview.targetLang &&
            (withReview.proposedDrafts ?? 0) > 0
          ) {
            return withReview.runId
          }
        }
        if (current && scoped.some((run) => run.runId === current)) return current
        return preferredRun(scoped, initialSection)?.runId ?? null
      })
      setRunsWarning(null)
    } catch {
      if (seq === seqRef.current) setRunsWarning("Could not refresh run history. Showing the last available details.")
    } finally {
      if (seq === seqRef.current) setLoadingRuns(false)
    }
  }, [fallbackRuns, focusFileId, initialSection, overview?.proposedDrafts, projectId])

  const loadOlderRuns = useCallback(async () => {
    const cursor = nextRunCursor
    if (!cursor || loadingOlderRuns) return
    setLoadingOlderRuns(true)
    try {
      const options: ContextualRunListOptions = { cursor }
      const page = await fetchContextualRuns(projectId, options)
      const next = mergeRuns(runsRef.current, page.runs)
      runsRef.current = next
      setRuns(next)
      pagedRunHistoryRef.current = true
      nextRunCursorRef.current = page.nextCursor
      setNextRunCursor(page.nextCursor)
      setRunsTruncated(page.truncated || page.nextCursor !== null)
      setRunsWarning(null)
    } catch {
      setRunsWarning("Could not load older run history. The runs already shown are still current.")
    } finally {
      setLoadingOlderRuns(false)
    }
  }, [loadingOlderRuns, nextRunCursor, projectId])

  const loadActivity = useCallback(async (runId: string) => {
    const seq = ++activitySeqRef.current
    setLoadingActivity(true)
    try {
      const options: ContextualRunActivityOptions = initialSection === "review"
        ? { draftStatus: "proposed", draftLimit: DRAFT_PAGE_SIZE }
        : { draftLimit: DRAFT_PAGE_SIZE }
      const next = await fetchContextualRunActivity(projectId, runId, options)
      if (seq !== activitySeqRef.current) return
      const previous = activityRunRef.current === runId ? activityRef.current : null
      if (previous) {
        const previousEventIds = new Set(previous.events.map((event) => event.id))
        const added = next.events.filter((event) => !previousEventIds.has(event.id))
        const latest = added.reduce<ContextualActivityEvent | null>((current, event) => {
          if (!current) return event
          return event.createdAt > current.createdAt ? event : current
        }, null)
        if (latest) setLatestStepAnnouncement(`Autopilot update: ${latest.summary.slice(0, 240)}`)
      }
      const totalDrafts = authoritativeDraftCount(next, initialSection)
      const canRetainLoadedPages = previous
        && pagedDraftRunRef.current === runId
        && (totalDrafts == null || totalDrafts >= previous.drafts.length)
      const merged = canRetainLoadedPages
        ? {
          ...next,
          drafts: mergeRefreshedDrafts(previous.drafts, next.drafts),
          // A first-page refresh must not move a user who already paged
          // backwards to a shallower cursor (or make an exhausted list
          // appear pageable again).
          draftNextCursor: previous.draftNextCursor,
        }
        : next
      if (!canRetainLoadedPages) pagedDraftRunRef.current = null
      activityRef.current = merged
      activityRunRef.current = runId
      setActivity(merged)
      if (merged.run) {
        const nextRuns = mergeRuns([merged.run], runsRef.current)
        runsRef.current = nextRuns
        setRuns(nextRuns)
      }
      setActivityWarning(null)
    } catch {
      if (seq === activitySeqRef.current) {
        setActivityWarning("Could not refresh detailed activity. Showing the last available run summary.")
      }
    } finally {
      if (seq === activitySeqRef.current) setLoadingActivity(false)
    }
  }, [initialSection, projectId])

  useEffect(() => {
    if (!open) {
      openSessionRef.current = false
      return
    }
    // Parent overview props can refresh while this Sheet remains open.
    // Initialize only once per open session so that refreshes cannot erase an
    // explicit run selection, especially the run created by Retry.
    if (openSessionRef.current) return
    openSessionRef.current = true
    setDetailsOpen(initialSection === "attention")
    setReviewOpen(initialSection === "review")
    setHistoryOpen(false)
    setContextOpen(initialSection === "context")
    setTechnicalOpen(false)
    setActionMessage(null)
    setRunsTruncated(false)
    pagedRunHistoryRef.current = false
    nextRunCursorRef.current = null
    setNextRunCursor(null)
    setRunsWarning(null)
    setActivityWarning(null)
    setLatestStepAnnouncement("")
    selectionOverrideRef.current = null
    runsRef.current = fallbackRuns
    setRuns(fallbackRuns)
    const openingRunId = focusRunId ?? preferredRun(fallbackRuns, initialSection)?.runId ?? null
    selectedRunRef.current = openingRunId
    setSelectedRunId(openingRunId)
    void loadRuns()
  }, [fallbackRuns, focusRunId, initialSection, loadRuns, open])

  useEffect(() => {
    if (!open || !selectedRun?.runId) return
    activityRef.current = null
    activityRunRef.current = selectedRun.runId
    pagedDraftRunRef.current = null
    setLatestStepAnnouncement("")
    setActivity(null)
    void loadActivity(selectedRun.runId)
  }, [loadActivity, open, selectedRun?.runId])

  useEffect(() => {
    if (selectedRun && (selectedRun.status === "failed" || selectedRun.lastError)) setDetailsOpen(true)
  }, [selectedRun])

  useEffect(() => {
    if (!open || !selectedRun || (!WORKING_STATUSES.has(selectedRun.status) && !runHasQueuedWork(selectedRun))) return
    const timer = setInterval(() => {
      void loadRuns()
      void loadActivity(selectedRun.runId)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [loadActivity, loadRuns, open, selectedRun])

  const handleCommand = async (command: ContextualRunCommand) => {
    if (!selectedRun || busy) return
    setBusy(command)
    setActionMessage(`${command === "terminate" ? "Stopping" : command === "pause" ? "Pausing" : "Resuming"} Autopilot…`)
    try {
      const updated = await commandContextualRun(projectId, selectedRun.runId, command)
      if (updated) {
        const nextRuns = mergeRuns([updated], runsRef.current)
        runsRef.current = nextRuns
        setRuns(nextRuns)
      }
      await Promise.all([loadRuns(), loadActivity(selectedRun.runId)])
      await onRunChanged?.()
      setActionMessage(command === "terminate" ? "Autopilot stopped." : command === "pause" ? "Pause requested." : "Autopilot resumed.")
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "The run could not be updated.")
    } finally {
      setBusy(null)
    }
  }

  const handleRetry = async () => {
    if (!selectedRun || busy) return
    setBusy("retry")
    setActionMessage("Starting Autopilot…")
    try {
      const next = await startFileContextualRun(projectId, selectedRun.fileId)
      const now = new Date().toISOString()
      const optimisticRun: ContextualRunRecord = {
        ...selectedRun,
        runId: next.runId,
        status: "running",
        phase: "Reading context…",
        spanLabel: null,
        done: 0,
        total: 0,
        failed: 0,
        unitsSpent: 0,
        callsSpent: 0,
        lastError: null,
        proposedDrafts: 0,
        createdAt: now,
        updatedAt: now,
      }
      selectionOverrideRef.current = next.runId
      selectedRunRef.current = next.runId
      const nextRuns = mergeRuns([optimisticRun], runsRef.current)
      runsRef.current = nextRuns
      setRuns(nextRuns)
      setSelectedRunId(next.runId)
      await loadRuns()
      await onRunChanged?.()
      setActionMessage("A new Autopilot run started for this file.")
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : "Autopilot could not start.")
    } finally {
      setBusy(null)
    }
  }

  const loadOlderDrafts = async () => {
    const selectedRunId = selectedRun?.runId
    const cursor: ContextualDraftCursor | null | undefined = activity?.draftNextCursor
    if (!selectedRunId || !cursor || loadingOlderDrafts) return
    const activitySeq = activitySeqRef.current
    setLoadingOlderDrafts(true)
    try {
      const options: ContextualRunActivityOptions = {
        ...(initialSection === "review" ? { draftStatus: "proposed" as const } : {}),
        draftLimit: DRAFT_PAGE_SIZE,
        draftCursor: cursor,
      }
      const next = await fetchContextualRunActivity(projectId, selectedRunId, options)
      if (activitySeq !== activitySeqRef.current || selectedRunRef.current !== selectedRunId) return
      setActivity((current) => {
        const merged = current
          ? {
            ...next,
            events: current.events,
            sceneBriefs: current.sceneBriefs,
            // Later keyset pages are older; prepend them to keep evidence in
            // chronological order while de-duplicating boundary rows.
            drafts: mergeDrafts(next.drafts, current.drafts),
            draftCounts: next.draftCounts ?? current.draftCounts,
          }
          : next
        activityRef.current = merged
        pagedDraftRunRef.current = selectedRunId
        return merged
      })
      if (activitySeq === activitySeqRef.current && selectedRunRef.current === selectedRunId) {
        setActivityWarning(null)
      }
    } catch {
      if (activitySeq === activitySeqRef.current && selectedRunRef.current === selectedRunId) {
        setActivityWarning("Could not load older draft evidence. The draft records already shown are still current.")
      }
    } finally {
      setLoadingOlderDrafts(false)
    }
  }

  const events = activity?.events ?? []
  const drafts = activity?.drafts ?? []
  const proposedDrafts = drafts.filter((draft) => draft.status === "proposed")
  const draftHistory = drafts.filter((draft) => draft.status !== "proposed")
  const sceneBriefs = activity?.sceneBriefs ?? []
  const suggestedContext = readiness?.items.filter((item) => item.level !== "ready") ?? []
  const legacyTruncated = activity?.truncated === true && !activity.truncatedCollections
  const eventsTruncated = activity?.truncatedCollections?.events ?? legacyTruncated
  const sceneBriefsTruncated = activity?.truncatedCollections?.sceneBriefs ?? legacyTruncated
  const draftsTruncated = activity?.truncatedCollections?.drafts ?? legacyTruncated
  const authoritativeProposedDrafts = activity?.draftCounts?.proposed
    ?? selectedRun?.proposedDrafts
    ?? proposedDrafts.length
  const proposedDraftCountLabel = proposedDrafts.length === authoritativeProposedDrafts
    ? String(authoritativeProposedDrafts)
    : `${proposedDrafts.length} of ${authoritativeProposedDrafts}`
  const authoritativeDraftHistory = activity?.draftCounts
    ? activity.draftCounts.applied
      + activity.draftCounts.rejected
      + activity.draftCounts.superseded
    : draftHistory.length
  const draftHistoryCountLabel = draftHistory.length === authoritativeDraftHistory
    ? String(authoritativeDraftHistory)
    : `${draftHistory.length} of ${authoritativeDraftHistory}`
  const selectedRunError = selectedRun ? humanRunError(selectedRun) : null
  const selectedRunHasCategoricalLaneError = Boolean(
    selectedRun?.lastError?.includes("unsupported_target_language_lane"),
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl!" data-testid="autopilot-activity-inspector">
        <SheetHeader className="pr-12">
          <SheetTitle>Autopilot activity</SheetTitle>
          <SheetDescription>
            See what Autopilot did, what it is doing now, and the evidence behind each step.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 px-4 pb-6">
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
              data-testid="autopilot-latest-step-announcement"
            >
              {latestStepAnnouncement}
            </p>
            {runsWarning && (
              <p role="status" className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {runsWarning}
              </p>
            )}
            {activityWarning && (
              <p role="status" className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {activityWarning}
              </p>
            )}

            <section aria-label="Autopilot runs" className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Runs</h3>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    void Promise.all([
                      loadRuns(),
                      selectedRun?.runId ? loadActivity(selectedRun.runId) : Promise.resolve(),
                    ])
                  }}
                  disabled={loadingRuns || loadingActivity}
                >
                  <RefreshCw data-icon="inline-start" aria-hidden />
                  Refresh
                </Button>
              </div>
              {initialSection === "review" && (overview?.proposedDrafts ?? 0) > 0 && (
                <p className="text-sm text-muted-foreground">
                  {overview!.proposedDrafts} {overview!.proposedDrafts === 1 ? "draft is" : "drafts are"} ready across this project. Runs with review work are marked below; select one to inspect its drafts.
                </p>
              )}
              {loadingRuns && scopedRuns.length === 0 ? (
                <div className="flex flex-col gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
              ) : scopedRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground">No Autopilot runs have been recorded yet.</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {scopedRuns.map((run) => (
                    <Button
                      key={run.runId}
                      type="button"
                      variant={run.runId === selectedRun?.runId ? "secondary" : "outline"}
                      className="h-auto min-w-0 justify-start whitespace-normal px-3 py-2 text-left"
                      aria-pressed={run.runId === selectedRun?.runId}
                      onClick={() => {
                        selectionOverrideRef.current = run.runId
                        selectedRunRef.current = run.runId
                        setSelectedRunId(run.runId)
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{fileNames?.get(run.fileId) ?? run.fileId}</span>
                        <span className="block text-xs text-muted-foreground">{run.total > 0 ? `${run.done}/${run.total} passages` : "Scanning passages"}</span>
                        <span className="block text-xs text-muted-foreground">
                          {run.targetLang ? `Target: ${run.targetLang}` : "Default language lane"}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {(run.proposedDrafts ?? 0) > 0 && (
                          <Badge variant="secondary">
                            {run.targetLang
                              ? `${run.proposedDrafts} evidence ${run.proposedDrafts === 1 ? "draft" : "drafts"}`
                              : `${run.proposedDrafts} ready to review`}
                          </Badge>
                        )}
                        <StatusBadge run={run} />
                      </span>
                    </Button>
                  ))}
                </div>
              )}
              {nextRunCursor && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={loadingOlderRuns}
                  onClick={() => void loadOlderRuns()}
                >
                  {loadingOlderRuns && <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden />}
                  Load older runs
                </Button>
              )}
              {runsTruncated && !nextRunCursor && (
                <p className="text-xs text-muted-foreground">
                  Showing the most recent runs. Older run history is not included in this view.
                </p>
              )}
            </section>

            {selectedRun && (
              <>
                <Separator />
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>{fileNames?.get(selectedRun.fileId) ?? selectedRun.fileId}</CardTitle>
                    <CardDescription>
                      {selectedRun.status === "running" && (selectedRun.phase ?? "Autopilot is working through this file.")}
                      {selectedRun.status === "pausing" && "Finishing the current step before pausing."}
                      {selectedRun.status === "paused" && "Paused. No new work will start until you resume."}
                      {selectedRun.status === "parked" && (runHasQueuedWork(selectedRun)
                        ? `${selectedRun.total - selectedRun.done - selectedRun.failed} passages remain queued. Autopilot will continue in the background.`
                        : "This run is idle; no more work is queued.")}
                      {selectedRun.status === "done" && "This run finished."}
                      {selectedRun.status === "terminated" && "This run was stopped."}
                      {selectedRun.status === "failed" && "This run stopped before it could finish."}
                    </CardDescription>
                    <CardAction><StatusBadge run={selectedRun} /></CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {selectedRun.total > 0 && (
                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                          <span>Passages complete</span><span className="tabular-nums">{selectedRun.done}/{selectedRun.total}</span>
                        </div>
                        <Progress value={(selectedRun.done / selectedRun.total) * 100} aria-label={`${selectedRun.done} of ${selectedRun.total} passages complete`} />
                      </div>
                    )}
                    {selectedRunError && !selectedRunHasCategoricalLaneError && (
                      <p className="flex items-start gap-2 text-sm text-destructive">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                        {selectedRunError}
                      </p>
                    )}
                    {selectedRun.targetLang && (
                      <p className="text-sm text-muted-foreground">
                        This run targets a multilingual lane that Autopilot doesn’t support yet. Its history is available, but it can’t be retried.
                      </p>
                    )}
                    <RunControls run={selectedRun} busy={busy} canControl={canControl} onCommand={(command) => void handleCommand(command)} onRetry={() => void handleRetry()} />
                    {actionMessage && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{actionMessage}</p>}
                  </CardContent>
                  <CardFooter className="justify-between gap-3 text-xs text-muted-foreground">
                    <span>Updated {formatTimestamp(selectedRun.updatedAt)}</span>
                    <span>{selectedRun.callsSpent} calls · {selectedRun.unitsSpent} units</span>
                    <span>{selectedRun.failed > 0 ? `${selectedRun.failed} failed` : "No failed passages"}</span>
                  </CardFooter>
                </Card>

                <Disclosure title="Run details" open={detailsOpen} onOpenChange={setDetailsOpen}>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="text-xs text-muted-foreground">Started</dt><dd>{formatTimestamp(selectedRun.createdAt)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Last update</dt><dd>{formatTimestamp(selectedRun.updatedAt)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Model calls</dt><dd className="tabular-nums">{selectedRun.callsSpent}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Units used</dt><dd className="tabular-nums">{selectedRun.unitsSpent}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Started by</dt><dd>{selectedRun.initiatedBy ?? "Not recorded"}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">Target language</dt><dd>{selectedRun.targetLang || "Project default"}</dd></div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">{selectedRun.runId}</code>
                    <Button type="button" size="xs" variant="outline" onClick={() => void copyText(selectedRun.runId).then(() => setActionMessage("Run ID copied."))}>
                      <Clipboard data-icon="inline-start" aria-hidden />Copy run ID
                    </Button>
                  </div>
                </Disclosure>

                <section aria-labelledby="autopilot-steps-title" className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 id="autopilot-steps-title" className="text-sm font-medium">Activity</h3>
                    {loadingActivity && events.length === 0 && <span className="text-xs text-muted-foreground">Loading steps…</span>}
                  </div>
                  <EventTimeline events={events} />
                  {eventsTruncated && <p className="text-xs text-muted-foreground">Only the most recent activity steps are shown for this run.</p>}
                </section>

                <Disclosure title="Ready to review" open={reviewOpen} onOpenChange={setReviewOpen} badge={<Badge variant="secondary">{proposedDraftCountLabel}</Badge>}>
                  {proposedDrafts.length > 0
                    ? proposedDrafts.map((draft, index) => <ReviewDraft key={draft.id ?? index} draft={draft} projectId={projectId} runTargetLang={selectedRun.targetLang} />)
                    : authoritativeProposedDrafts > 0
                      ? <p className="text-sm text-muted-foreground">No ready-to-review drafts are loaded from this bounded page yet. {authoritativeProposedDrafts} remain recorded for this run.</p>
                      : <p className="text-sm text-muted-foreground">No drafts from this run are waiting for review. Choose a run marked “ready to review” above.</p>}
                  {draftsTruncated && (
                    <p className="text-xs text-muted-foreground">
                      Showing {proposedDrafts.length} of {authoritativeProposedDrafts} ready-to-review draft records for this run.
                    </p>
                  )}
                  {activity?.draftNextCursor && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="self-start"
                      disabled={loadingOlderDrafts}
                      onClick={() => void loadOlderDrafts()}
                    >
                      {loadingOlderDrafts && <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden />}
                      {initialSection === "review" ? "Load more ready-to-review drafts" : "Load more draft records"}
                    </Button>
                  )}
                </Disclosure>

                {initialSection !== "review" && authoritativeDraftHistory > 0 && (
                  <Disclosure title="Draft history" open={historyOpen} onOpenChange={setHistoryOpen} badge={<Badge variant="secondary">{draftHistoryCountLabel}</Badge>}>
                    <p className="text-sm text-muted-foreground">Previously applied, rejected, or superseded drafts from this run.</p>
                    {draftHistory.map((draft, index) => <ReviewDraft key={draft.id ?? index} draft={draft} projectId={projectId} runTargetLang={selectedRun.targetLang} />)}
                    {draftsTruncated && <p className="text-xs text-muted-foreground">Showing {draftHistory.length} of {authoritativeDraftHistory} historical draft records for this run.</p>}
                  </Disclosure>
                )}
                {initialSection === "review" && authoritativeDraftHistory > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {authoritativeDraftHistory} historical {authoritativeDraftHistory === 1 ? "draft is" : "drafts are"} recorded for this run. Open Activity to inspect non-proposed draft history.
                  </p>
                )}

                <Disclosure title="Context" open={contextOpen} onOpenChange={setContextOpen} badge={<Badge variant="secondary">{suggestedContext.length}</Badge>}>
                  {readiness && (
                    <div className="flex flex-col gap-2">
                      {readiness.blockingGaps > 0 && <p className="text-sm font-medium">{readiness.blockingGaps} missing {readiness.blockingGaps === 1 ? "essential" : "essentials"}</p>}
                      {readiness.items.map((item) => (
                        <div key={item.id} className="flex items-start justify-between gap-3 text-sm">
                          <div><p className="font-medium">{item.label}</p><p className="text-muted-foreground">{item.detail}</p></div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant="outline">{item.level}</Badge>
                            {item.href && item.level !== "ready" && <a aria-label={`Set up ${item.label}`} href={`/project/${projectId}/${item.href}`} className="text-xs text-primary underline-offset-2 hover:underline">Set up</a>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {sceneBriefs.map((brief, index) => <SceneBriefEvidence key={brief.id ?? index} brief={brief} />)}
                  {!readiness && sceneBriefs.length === 0 && <p className="text-sm text-muted-foreground">No context evidence was recorded for this run.</p>}
                  {sceneBriefsTruncated && <p className="text-xs text-muted-foreground">Only the most recent scene briefs are shown for this run.</p>}
                </Disclosure>

                <Disclosure title="Technical & evidence" open={technicalOpen} onOpenChange={setTechnicalOpen} badge={<Badge variant="secondary">{eventsTruncated ? `${events.length}+` : events.length}</Badge>}>
                  <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void copyText(activityLog(selectedRun, activity)).then(() => setActionMessage("Activity log copied."))}>
                    <Clipboard data-icon="inline-start" aria-hidden />Copy activity log
                  </Button>
                  <p className="text-xs text-muted-foreground">The copied JSON contains run metadata and sanitized event evidence. Prompts, credentials, and tokens are redacted.</p>
                  {events.map((event) => {
                    const spanId = event.spanId
                    return (
                      <div key={event.id} className="flex flex-col gap-2 rounded-lg bg-muted p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium">{event.summary}</span>{spanId && <Button type="button" size="xs" variant="ghost" onClick={() => void copyText(spanId).then(() => setActionMessage("Span ID copied."))}><Clipboard data-icon="inline-start" aria-hidden />Copy span ID</Button>}</div>
                        <pre className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{JSON.stringify(redactedDetails(event.details), null, 2)}</pre>
                      </div>
                    )
                  })}
                </Disclosure>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
