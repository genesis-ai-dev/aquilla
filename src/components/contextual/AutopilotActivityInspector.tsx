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
import { useI18n, useT, type TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
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

function statusLabel(run: ContextualRunRecord, t: TFunction): string {
  if (run.status === "failed") return t("autopilot.status.needsAttention")
  if (run.status === "running" || run.status === "pausing") return t("autopilot.status.working")
  if (run.status === "paused") return t("autopilot.status.paused")
  if (run.status === "parked") {
    return t(runHasQueuedWork(run) ? "autopilot.status.queued" : "autopilot.status.idle")
  }
  if (run.status === "done") return t("autopilot.status.complete")
  if (run.status === "terminated") return t("autopilot.status.stopped")
  return t("autopilot.status.notStarted")
}

function StatusBadge({ run }: { run: ContextualRunRecord }) {
  const t = useT()
  const label = statusLabel(run, t)
  const variant = run.status === "failed"
    ? "destructive"
    : run.status === "running" || run.status === "pausing"
      ? "default"
      : "outline"
  return (
    <Badge variant={variant}>
      {(run.status === "running" || run.status === "pausing") && (
        <LoaderCircle data-icon="inline-start" className="animate-spin motion-reduce:animate-none" aria-hidden />
      )}
      {run.status === "failed" && <AlertTriangle data-icon="inline-start" aria-hidden />}
      {label}
    </Badge>
  )
}

function formatTimestamp(
  value: string | null | undefined,
  locale: string,
  t: TFunction,
): string {
  if (!value) return t("autopilot.time.notRecorded")
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return t("autopilot.time.notRecorded")
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function phaseLabel(value: string | null | undefined, t: TFunction): string | null {
  if (!value) return null
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[….]+$/u, "")
  if (normalized === "reading" || normalized === "reading context") {
    return t("autopilot.phase.reading")
  }
  if (normalized === "drafting" || normalized === "drafting translations") {
    return t("autopilot.phase.drafting")
  }
  if (normalized === "checking" || normalized === "checking drafts") {
    return t("autopilot.phase.checking")
  }
  if (
    normalized === "staging" ||
    normalized === "saving drafts" ||
    normalized === "staging reviewable drafts"
  ) {
    return t("autopilot.phase.staging")
  }
  return null
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

function humanRunError(run: ContextualRunRecord, t: TFunction): string | null {
  if (!run.lastError) return null
  if (run.lastError.includes("unsupported_target_language_lane")) {
    return t("autopilot.inspector.error.unsupportedLane")
  }
  if (/provider_request_aborted\b/i.test(run.lastError)) {
    return t("autopilot.inspector.error.requestAborted")
  }
  if (/provider_transport_error\b/i.test(run.lastError)) {
    return t("autopilot.inspector.error.transport")
  }
  if (/provider_invalid_response(?:\s+status=\d+)?/i.test(run.lastError)) {
    return t("autopilot.inspector.error.invalidResponse")
  }
  if (/provider_http_error(?:\s+status=\d+)?/i.test(run.lastError)) {
    return t("autopilot.inspector.error.http")
  }
  if (/span_partial_cells_skipped\b/i.test(run.lastError)) {
    return t("autopilot.inspector.error.partialCells")
  }
  if (/span_all_cells_skipped\b/i.test(run.lastError)) {
    return t("autopilot.inspector.error.allCells")
  }
  return t("autopilot.inspector.error.generic")
}

interface LocalizedNotice {
  key: MessageKey
  vars?: Record<string, string | number>
}

type InspectorNotice = LocalizedNotice

function noticeText(notice: InspectorNotice | null, t: TFunction): string | null {
  if (!notice) return null
  return t(notice.key, notice.vars)
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
  const t = useT()
  if (!canControl) return null
  return (
    <div className="flex flex-wrap gap-2">
      {run.status === "running" && !run.targetLang && (
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onCommand("pause")}>
          <Pause data-icon="inline-start" aria-hidden />
          {t("common.pause")}
        </Button>
      )}
      {run.status === "paused" && !run.targetLang && (
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onCommand("resume")}>
          <Play data-icon="inline-start" aria-hidden />
          {t("autopilot.action.resume")}
        </Button>
      )}
      {["running", "pausing", "paused", "parked"].includes(run.status) && (
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => onCommand("terminate")}>
          <Square data-icon="inline-start" aria-hidden />
          {t("common.stop")}
        </Button>
      )}
      {run.status === "failed" && !run.targetLang && (
        <Button type="button" size="sm" disabled={busy !== null} onClick={onRetry}>
          <Play data-icon="inline-start" aria-hidden />
          {t("autopilot.action.run")}
        </Button>
      )}
    </div>
  )
}

const EVENT_KIND_KEYS: Record<string, MessageKey> = {
  run_created: "autopilot.inspector.event.kind.runCreated",
  run_state: "autopilot.inspector.event.kind.runState",
  span_started: "autopilot.inspector.event.kind.spanStarted",
  phase: "autopilot.inspector.event.kind.phase",
  scene_ready: "autopilot.inspector.event.kind.sceneReady",
  drafts_staged: "autopilot.inspector.event.kind.draftsStaged",
  span_outcome: "autopilot.inspector.event.kind.spanOutcome",
  steering_queued: "autopilot.inspector.event.kind.steeringQueued",
  draft_reviewed: "autopilot.inspector.event.kind.draftReviewed",
}

function detailNumber(event: ContextualActivityEvent, key: string): number | null {
  const value = event.details[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function eventKindLabel(event: ContextualActivityEvent, t: TFunction): string {
  const key = EVENT_KIND_KEYS[event.kind]
  return key ? t(key) : t("autopilot.inspector.event.kind.unknown")
}

function evidenceStatusLabel(status: string | null | undefined, t: TFunction): string | null {
  if (!status) return null
  const keyByStatus: Partial<Record<string, MessageKey>> = {
    proposed: "autopilot.evidence.status.proposed",
    applied: "autopilot.evidence.status.applied",
    rejected: "autopilot.evidence.status.rejected",
    superseded: "autopilot.evidence.status.superseded",
    approved: "autopilot.evidence.status.approved",
    archived: "autopilot.evidence.status.archived",
  }
  const key = keyByStatus[status]
  return key ? t(key) : t("autopilot.evidence.status.unknown")
}

function eventStatusLabel(event: ContextualActivityEvent, t: TFunction): string | null {
  const status = event.status
  if (!status) {
    return event.phase
      ? phaseLabel(event.phase, t) ?? t("autopilot.inspector.event.phaseChanged")
      : null
  }
  if (status === "running" || status === "pausing") return t("autopilot.status.working")
  if (status === "paused") return t("autopilot.status.paused")
  if (status === "parked") {
    const done = detailNumber(event, "done") ?? 0
    const failed = detailNumber(event, "failed") ?? 0
    const total = detailNumber(event, "total") ?? 0
    return t(total > done + failed ? "autopilot.status.queued" : "autopilot.status.idle")
  }
  if (status === "done" || status === "complete") return t("autopilot.status.complete")
  if (status === "failed") return t("autopilot.status.needsAttention")
  if (status === "terminated") return t("autopilot.status.stopped")
  if (status === "started") return t("autopilot.inspector.event.status.started")
  if (status === "partial") return t("autopilot.inspector.event.status.partial")
  if (status === "queued") return t("autopilot.inspector.event.status.queued")
  return evidenceStatusLabel(status, t) ?? status
}

function eventSummary(event: ContextualActivityEvent, t: TFunction): string {
  if (event.kind === "run_created") return t("autopilot.inspector.event.runStarted")
  if (event.kind === "run_state") {
    if (event.status === "parked") {
      const done = detailNumber(event, "done") ?? 0
      const failed = detailNumber(event, "failed") ?? 0
      const total = detailNumber(event, "total") ?? 0
      if (total > done + failed) return t("autopilot.inspector.event.workQueued")
      return t("autopilot.inspector.event.idle")
    }
    if (event.status === "running") return t("autopilot.inspector.event.running")
    if (event.status === "pausing") return t("autopilot.inspector.event.pauseRequested")
    if (event.status === "paused") return t("autopilot.inspector.event.paused")
    if (event.status === "done") return t("autopilot.inspector.event.completed")
    if (event.status === "failed") return t("autopilot.inspector.event.error")
    if (event.status === "terminated") return t("autopilot.inspector.event.terminated")
    return t("autopilot.inspector.event.statusChanged")
  }
  if (event.kind === "span_started") {
    return event.spanLabel
      ? t("autopilot.inspector.event.spanStarted", { spanLabel: event.spanLabel })
      : t("autopilot.inspector.event.spanStartedGeneric")
  }
  if (event.kind === "phase") {
    return phaseLabel(event.phase, t) ?? t("autopilot.inspector.event.phaseChanged")
  }
  if (event.kind === "scene_ready") return t("autopilot.inspector.event.sceneReady")
  if (event.kind === "drafts_staged") {
    const count = detailNumber(event, "count") ?? detailNumber(event, "staged")
    return count == null
      ? event.summary
      : t("autopilot.inspector.event.draftsStaged", { count })
  }
  if (event.kind === "span_outcome") {
    if (event.status === "failed") return t("autopilot.inspector.event.spanFailed")
    if (event.status === "partial") return t("autopilot.inspector.event.spanPartial")
    return t("autopilot.inspector.event.spanComplete")
  }
  if (event.kind === "steering_queued") {
    return event.details.steeringKind === "direction"
      ? t("autopilot.inspector.event.directionQueued")
      : t("autopilot.inspector.event.kind.steeringQueued")
  }
  if (event.kind === "draft_reviewed") {
    if (event.details.outcome === "applied") return t("autopilot.inspector.event.draftApplied")
    if (event.details.outcome === "superseded") {
      return t("autopilot.inspector.event.draftSuperseded")
    }
    return t("autopilot.inspector.event.draftRejected")
  }
  // Unknown future summaries are durable evidence. Preserve them verbatim
  // until the client has enough structured data to translate them honestly.
  return event.summary
}

function EventTimeline({ events }: { events: ContextualActivityEvent[] }) {
  const { locale, t } = useI18n()
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("autopilot.inspector.activity.empty")}
      </p>
    )
  }
  return (
    <ol
      role="log"
      aria-live="off"
      aria-label={t("autopilot.inspector.activity.logAria")}
      className="flex flex-col gap-3"
    >
      {events.map((event) => (
        <li key={event.id} className="flex gap-3">
          <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{eventKindLabel(event, t)}</Badge>
              {(event.phase || event.status) && (
                <Badge variant="secondary">{eventStatusLabel(event, t)}</Badge>
              )}
              <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                {formatTimestamp(event.createdAt, locale, t)}
              </time>
            </div>
            <p className="mt-1 text-sm">{eventSummary(event, t)}</p>
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
  const t = useT()
  const provenance = draft.provenance && Object.keys(draft.provenance).length > 0
    ? JSON.stringify(draft.provenance)
    : t("autopilot.inspector.review.noProvenance")
  const draftStatus = evidenceStatusLabel(draft.status, t)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{draft.cellId
          ? t("common.cellLabel", { id: draft.cellId })
          : t("autopilot.inspector.review.draftTitle")}</CardTitle>
        <CardDescription>{provenance}</CardDescription>
        <CardAction>
          <Badge variant="outline">
            {draftStatus ?? t("autopilot.evidence.status.unknown")}
          </Badge>
        </CardAction>
      </CardHeader>
      {draft.text && <CardContent><p className="whitespace-pre-wrap">{draft.text}</p></CardContent>}
      {draft.status === "proposed" && draft.fileId && !runTargetLang && (
        <CardFooter>
          <a
            href={defaultLaneDraftReviewHref(projectId, draft.fileId, draft.cellId)}
            aria-label={draft.cellId
              ? t("autopilot.inspector.review.inEditorCell", { cellId: draft.cellId })
              : t("autopilot.inspector.review.inEditor")}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("autopilot.inspector.review.inEditor")}
          </a>
        </CardFooter>
      )}
      {draft.status === "proposed" && runTargetLang && (
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            {t("autopilot.inspector.review.unsupportedLaneEvidence", {
              language: runTargetLang,
            })}
          </p>
        </CardFooter>
      )}
    </Card>
  )
}

function SceneBriefEvidence({ brief }: { brief: ContextualActivitySceneBrief }) {
  const t = useT()
  const ambiguities = Array.isArray(brief.ambiguityRegister) ? brief.ambiguityRegister : []
  const status = evidenceStatusLabel(brief.status, t)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{brief.startCellId && brief.endCellId
          ? `${brief.startCellId} → ${brief.endCellId}`
          : t("autopilot.inspector.context.sceneBrief")}</CardTitle>
        <CardDescription>
          {brief.l1Summary ?? t("autopilot.inspector.context.noSceneSummary")}
        </CardDescription>
        {status && <CardAction><Badge variant="outline">{status}</Badge></CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {brief.construal && (
          <div>
            <p className="text-xs font-medium">{t("autopilot.inspector.context.construal")}</p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{brief.construal}</p>
          </div>
        )}
        <div>
          <p className="text-xs font-medium">
            {t("autopilot.inspector.context.ambiguities", { count: ambiguities.length })}
          </p>
          {ambiguities.length > 0 ? (
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
              {ambiguities.map((item, index) => (
                <li key={item.id ?? index}>
                  {item.question ?? t("autopilot.inspector.context.unlabelledAmbiguity")}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("autopilot.inspector.context.noneRecorded")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

type ReadinessItem = ContextReadiness["items"][number]

function readinessItemLabel(item: ReadinessItem, t: TFunction): string {
  const keyById: Partial<Record<string, MessageKey>> = {
    terminology: "autopilot.readiness.terminology.label",
    brief: "autopilot.readiness.brief.label",
    examples: "autopilot.readiness.examples.label",
    rules: "autopilot.readiness.rules.label",
    languages: "autopilot.readiness.languages.label",
  }
  const key = keyById[item.id]
  // Unknown future readiness checks remain visible instead of becoming a raw key.
  return key ? t(key) : item.label
}

function readinessLevelLabel(item: ReadinessItem, t: TFunction): string {
  const keyByLevel: Partial<Record<string, MessageKey>> = {
    ready: "autopilot.readiness.level.ready",
    partial: "autopilot.readiness.level.partial",
    missing: "autopilot.readiness.level.missing",
  }
  const key = keyByLevel[item.level]
  return key ? t(key) : item.level
}

function readinessItemDetail(item: ReadinessItem, t: TFunction): string {
  if (item.id === "terminology" && item.level === "missing") {
    return t("autopilot.readiness.terminology.none")
  }
  if (item.id === "brief" && item.level === "missing") {
    return t("autopilot.readiness.brief.none")
  }
  if (item.id === "examples" && item.level === "missing") {
    return t("autopilot.readiness.examples.none")
  }
  if (item.id === "languages" && item.level !== "ready") {
    return t("autopilot.readiness.languages.unset")
  }
  // The transport currently embeds counts, summary availability, and language
  // names inside English prose. Parsing that prose would couple localization to
  // server wording, so preserve it until the payload exposes structured fields.
  return item.detail
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
  const { locale, t } = useI18n()
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
  const [runsWarning, setRunsWarning] = useState<MessageKey | null>(null)
  const [activityWarning, setActivityWarning] = useState<MessageKey | null>(null)
  const [latestStepEvent, setLatestStepEvent] = useState<ContextualActivityEvent | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(initialSection === "attention")
  const [reviewOpen, setReviewOpen] = useState(initialSection === "review")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(initialSection === "context")
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<InspectorNotice | null>(null)
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
      if (seq === seqRef.current) {
        setRunsWarning("autopilot.inspector.warning.runsRefresh")
      }
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
      setRunsWarning("autopilot.inspector.warning.olderRuns")
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
        if (latest) setLatestStepEvent(latest)
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
        setActivityWarning("autopilot.inspector.warning.activityRefresh")
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
    setLatestStepEvent(null)
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
    setLatestStepEvent(null)
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
    setActionMessage({
      key: command === "terminate"
        ? "autopilot.inspector.action.stopping"
        : command === "pause"
          ? "autopilot.inspector.action.pausing"
          : "autopilot.inspector.action.resuming",
    })
    try {
      const updated = await commandContextualRun(projectId, selectedRun.runId, command)
      if (updated) {
        const nextRuns = mergeRuns([updated], runsRef.current)
        runsRef.current = nextRuns
        setRuns(nextRuns)
      }
      await Promise.all([loadRuns(), loadActivity(selectedRun.runId)])
      await onRunChanged?.()
      setActionMessage({
        key: command === "terminate"
          ? "autopilot.feedback.stopped"
          : command === "pause"
            ? "autopilot.feedback.pauseRequested"
            : "autopilot.feedback.resumed",
      })
    } catch {
      setActionMessage({ key: "autopilot.inspector.action.updateFailed" })
    } finally {
      setBusy(null)
    }
  }

  const handleRetry = async () => {
    if (!selectedRun || busy) return
    setBusy("retry")
    setActionMessage({ key: "autopilot.feedback.starting" })
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
      setActionMessage({ key: "autopilot.feedback.newRunStarted" })
    } catch {
      setActionMessage({ key: "autopilot.error.startFailed" })
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
        setActivityWarning("autopilot.inspector.warning.olderDrafts")
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
    : t("autopilot.inspector.count.visibleOfTotal", {
      visible: proposedDrafts.length,
      total: authoritativeProposedDrafts,
    })
  const authoritativeDraftHistory = activity?.draftCounts
    ? activity.draftCounts.applied
      + activity.draftCounts.rejected
      + activity.draftCounts.superseded
    : draftHistory.length
  const draftHistoryCountLabel = draftHistory.length === authoritativeDraftHistory
    ? String(authoritativeDraftHistory)
    : t("autopilot.inspector.count.visibleOfTotal", {
      visible: draftHistory.length,
      total: authoritativeDraftHistory,
    })
  const selectedRunError = selectedRun ? humanRunError(selectedRun, t) : null
  const selectedRunHasCategoricalLaneError = Boolean(
    selectedRun?.lastError?.includes("unsupported_target_language_lane"),
  )
  const runsWarningText = runsWarning ? t(runsWarning) : null
  const activityWarningText = activityWarning ? t(activityWarning) : null
  const actionMessageText = noticeText(actionMessage, t)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl!" data-testid="autopilot-activity-inspector">
        <SheetHeader className="pr-12">
          <SheetTitle>{t("autopilot.inspector.title")}</SheetTitle>
          <SheetDescription>
            {t("autopilot.inspector.description")}
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
              {latestStepEvent
                ? t("autopilot.inspector.activity.updateAnnouncement", {
                  summary: eventSummary(latestStepEvent, t),
                })
                : ""}
            </p>
            {runsWarningText && (
              <p role="status" className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {runsWarningText}
              </p>
            )}
            {activityWarningText && (
              <p role="status" className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {activityWarningText}
              </p>
            )}

            <section aria-label={t("autopilot.inspector.runsRegion")} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{t("autopilot.inspector.runsHeading")}</h3>
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
                  {t("common.refresh")}
                </Button>
              </div>
              {initialSection === "review" && (overview?.proposedDrafts ?? 0) > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("autopilot.inspector.projectReviewCount", {
                    count: overview!.proposedDrafts,
                  })}
                </p>
              )}
              {loadingRuns && scopedRuns.length === 0 ? (
                <div className="flex flex-col gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
              ) : scopedRuns.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("autopilot.inspector.noRuns")}
                </p>
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
                        <span className="block text-xs text-muted-foreground">
                          {run.total > 0
                            ? t("autopilot.progress.passagesComplete", {
                              done: run.done,
                              total: run.total,
                            })
                            : t("autopilot.inspector.scanningPassages")}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {run.targetLang
                            ? t("autopilot.inspector.targetLanguage", { language: run.targetLang })
                            : t("autopilot.inspector.defaultLane")}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {(run.proposedDrafts ?? 0) > 0 && (
                          <Badge variant="secondary">
                            {run.targetLang
                              ? t("autopilot.inspector.evidenceDrafts", {
                                count: run.proposedDrafts ?? 0,
                              })
                              : t("autopilot.inspector.readyCount", {
                                count: run.proposedDrafts ?? 0,
                              })}
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
                  {t("autopilot.inspector.loadOlderRuns")}
                </Button>
              )}
              {runsTruncated && !nextRunCursor && (
                <p className="text-xs text-muted-foreground">
                  {t("autopilot.inspector.recentRunsOnly")}
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
                      {selectedRun.status === "running" && (
                        phaseLabel(selectedRun.phase, t) ?? t("autopilot.inspector.run.working")
                      )}
                      {selectedRun.status === "pausing" && t("autopilot.inspector.run.pausing")}
                      {selectedRun.status === "paused" && t("autopilot.inspector.run.paused")}
                      {selectedRun.status === "parked" && (runHasQueuedWork(selectedRun)
                        ? t("autopilot.inspector.run.queued", {
                          count: selectedRun.total - selectedRun.done - selectedRun.failed,
                        })
                        : t("autopilot.inspector.run.idle"))}
                      {selectedRun.status === "done" && t("autopilot.inspector.run.done")}
                      {selectedRun.status === "terminated" && t("autopilot.inspector.run.stopped")}
                      {selectedRun.status === "failed" && t("autopilot.inspector.run.failed")}
                    </CardDescription>
                    <CardAction><StatusBadge run={selectedRun} /></CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {selectedRun.total > 0 && (
                      <div className="flex flex-col gap-1">
                        <div className="flex justify-between gap-2 text-xs text-muted-foreground">
                          <span>{t("autopilot.inspector.run.passagesComplete")}</span>
                          <span className="tabular-nums">{selectedRun.done}/{selectedRun.total}</span>
                        </div>
                        <Progress
                          value={(selectedRun.done / selectedRun.total) * 100}
                          aria-label={t("autopilot.progress.passagesComplete", {
                            done: selectedRun.done,
                            total: selectedRun.total,
                          })}
                        />
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
                        {t("autopilot.inspector.error.unsupportedLane")}
                      </p>
                    )}
                    <RunControls run={selectedRun} busy={busy} canControl={canControl} onCommand={(command) => void handleCommand(command)} onRetry={() => void handleRetry()} />
                    {actionMessageText && (
                      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                        {actionMessageText}
                      </p>
                    )}
                  </CardContent>
                  <CardFooter className="justify-between gap-3 text-xs text-muted-foreground">
                    <span>{t("autopilot.inspector.run.updatedAt", {
                      time: formatTimestamp(selectedRun.updatedAt, locale, t),
                    })}</span>
                    <span className="flex flex-wrap gap-x-2">
                      <span>
                        {t("autopilot.inspector.run.calls", { count: selectedRun.callsSpent })}
                      </span>
                      <span>
                        {t("autopilot.inspector.run.units", { count: selectedRun.unitsSpent })}
                      </span>
                    </span>
                    <span>{selectedRun.failed > 0
                      ? t("autopilot.inspector.run.failedPassages", { count: selectedRun.failed })
                      : t("autopilot.inspector.run.noFailedPassages")}</span>
                  </CardFooter>
                </Card>

                <Disclosure title={t("autopilot.inspector.details.title")} open={detailsOpen} onOpenChange={setDetailsOpen}>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div><dt className="text-xs text-muted-foreground">{t("autopilot.inspector.details.started")}</dt><dd>{formatTimestamp(selectedRun.createdAt, locale, t)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("autopilot.inspector.details.lastUpdate")}</dt><dd>{formatTimestamp(selectedRun.updatedAt, locale, t)}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("autopilot.inspector.details.modelCalls")}</dt><dd className="tabular-nums">{selectedRun.callsSpent}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("autopilot.inspector.details.unitsUsed")}</dt><dd className="tabular-nums">{selectedRun.unitsSpent}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("autopilot.inspector.details.startedBy")}</dt><dd>{selectedRun.initiatedBy ?? t("autopilot.time.notRecorded")}</dd></div>
                    <div><dt className="text-xs text-muted-foreground">{t("autopilot.inspector.details.targetLanguage")}</dt><dd>{selectedRun.targetLang || t("autopilot.lane.projectDefault")}</dd></div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="max-w-full truncate rounded bg-muted px-2 py-1 text-xs">{selectedRun.runId}</code>
                    <Button type="button" size="xs" variant="outline" onClick={() => void copyText(selectedRun.runId).then(() => setActionMessage({ key: "autopilot.inspector.details.runIdCopied" }))}>
                      <Clipboard data-icon="inline-start" aria-hidden />
                      {t("autopilot.inspector.details.copyRunId")}
                    </Button>
                  </div>
                </Disclosure>

                <section aria-labelledby="autopilot-steps-title" className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 id="autopilot-steps-title" className="text-sm font-medium">
                      {t("autopilot.inspector.activity.title")}
                    </h3>
                    {loadingActivity && events.length === 0 && (
                      <span className="text-xs text-muted-foreground">
                        {t("autopilot.inspector.activity.loading")}
                      </span>
                    )}
                  </div>
                  <EventTimeline events={events} />
                  {eventsTruncated && (
                    <p className="text-xs text-muted-foreground">
                      {t("autopilot.inspector.activity.recentOnly")}
                    </p>
                  )}
                </section>

                <Disclosure title={t("autopilot.status.readyForReview")} open={reviewOpen} onOpenChange={setReviewOpen} badge={<Badge variant="secondary">{proposedDraftCountLabel}</Badge>}>
                  {proposedDrafts.length > 0
                    ? proposedDrafts.map((draft, index) => <ReviewDraft key={draft.id ?? index} draft={draft} projectId={projectId} runTargetLang={selectedRun.targetLang} />)
                    : authoritativeProposedDrafts > 0
                      ? (
                        <p className="text-sm text-muted-foreground">
                          {t("autopilot.inspector.review.noneLoaded", {
                            count: authoritativeProposedDrafts,
                          })}
                        </p>
                      )
                      : (
                        <p className="text-sm text-muted-foreground">
                          {t("autopilot.inspector.review.noneWaiting")}
                        </p>
                      )}
                  {draftsTruncated && (
                    <p className="text-xs text-muted-foreground">
                      {t("autopilot.inspector.review.showingRecords", {
                        visible: proposedDrafts.length,
                        total: authoritativeProposedDrafts,
                      })}
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
                      {t(initialSection === "review"
                        ? "autopilot.inspector.review.loadMore"
                        : "autopilot.inspector.review.loadMoreRecords")}
                    </Button>
                  )}
                </Disclosure>

                {initialSection !== "review" && authoritativeDraftHistory > 0 && (
                  <Disclosure title={t("autopilot.inspector.history.title")} open={historyOpen} onOpenChange={setHistoryOpen} badge={<Badge variant="secondary">{draftHistoryCountLabel}</Badge>}>
                    <p className="text-sm text-muted-foreground">
                      {t("autopilot.inspector.history.description")}
                    </p>
                    {draftHistory.map((draft, index) => <ReviewDraft key={draft.id ?? index} draft={draft} projectId={projectId} runTargetLang={selectedRun.targetLang} />)}
                    {draftsTruncated && (
                      <p className="text-xs text-muted-foreground">
                        {t("autopilot.inspector.history.showingRecords", {
                          visible: draftHistory.length,
                          total: authoritativeDraftHistory,
                        })}
                      </p>
                    )}
                  </Disclosure>
                )}
                {initialSection === "review" && authoritativeDraftHistory > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("autopilot.inspector.history.recorded", {
                      count: authoritativeDraftHistory,
                    })}
                  </p>
                )}

                <Disclosure title={t("autopilot.inspector.context.title")} open={contextOpen} onOpenChange={setContextOpen} badge={<Badge variant="secondary">{suggestedContext.length}</Badge>}>
                  {readiness && (
                    <div className="flex flex-col gap-2">
                      {readiness.blockingGaps > 0 && (
                        <p className="text-sm font-medium">
                          {t("autopilot.inspector.context.missingEssentials", {
                            count: readiness.blockingGaps,
                          })}
                        </p>
                      )}
                      {readiness.items.map((item) => {
                        const itemLabel = readinessItemLabel(item, t)
                        return (
                          <div key={item.id} className="flex items-start justify-between gap-3 text-sm">
                            <div>
                              <p className="font-medium">{itemLabel}</p>
                              <p className="text-muted-foreground">
                                {readinessItemDetail(item, t)}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Badge variant="outline">{readinessLevelLabel(item, t)}</Badge>
                              {item.href && item.level !== "ready" && (
                                <a
                                  aria-label={t("autopilot.inspector.context.setupNamed", {
                                    label: itemLabel,
                                  })}
                                  href={`/project/${projectId}/${item.href}`}
                                  className="text-xs text-primary underline-offset-2 hover:underline"
                                >
                                  {t("autopilot.inspector.context.setup")}
                                </a>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {sceneBriefs.map((brief, index) => <SceneBriefEvidence key={brief.id ?? index} brief={brief} />)}
                  {!readiness && sceneBriefs.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t("autopilot.inspector.context.noEvidence")}
                    </p>
                  )}
                  {sceneBriefsTruncated && (
                    <p className="text-xs text-muted-foreground">
                      {t("autopilot.inspector.context.recentBriefsOnly")}
                    </p>
                  )}
                </Disclosure>

                <Disclosure title={t("autopilot.inspector.technical.title")} open={technicalOpen} onOpenChange={setTechnicalOpen} badge={<Badge variant="secondary">{eventsTruncated ? `${events.length}+` : events.length}</Badge>}>
                  <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void copyText(activityLog(selectedRun, activity)).then(() => setActionMessage({ key: "autopilot.inspector.technical.activityLogCopied" }))}>
                    <Clipboard data-icon="inline-start" aria-hidden />
                    {t("autopilot.inspector.technical.copyActivityLog")}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {t("autopilot.inspector.technical.copyDescription")}
                  </p>
                  {events.map((event) => {
                    const spanId = event.spanId
                    return (
                      <div key={event.id} className="flex flex-col gap-2 rounded-lg bg-muted p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium">{event.summary}</span>
                          {spanId && (
                            <Button type="button" size="xs" variant="ghost" onClick={() => void copyText(spanId).then(() => setActionMessage({ key: "autopilot.inspector.technical.spanIdCopied" }))}>
                              <Clipboard data-icon="inline-start" aria-hidden />
                              {t("autopilot.inspector.technical.copySpanId")}
                            </Button>
                          )}
                        </div>
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
