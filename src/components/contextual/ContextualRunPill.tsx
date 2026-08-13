// Floating play/pause pill for the contextual drafting run (design §10 of the
// contextual-translation-pipeline spec). Renders inside the editor viewport
// wrapper at `absolute bottom-4 right-4 z-30` (the floating-chip layer per
// AppShell's z-scale) so it disappears automatically on non-editor surfaces.
//
// The pill is a live readout of the run-store MIRROR — the run itself is a
// durable server-side workflow; closing the tab changes nothing. All strings
// here are plain user words (ui-jargon-guard.test.ts bans spec ids).

import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, CheckCircle2, Eye, ListTree, Pause, Play, Sparkles, X } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useEditorScroll } from "@/context/EditorScrollContext"
import {
  attachContextualRun,
  dismissContextualRunSummary,
  getContextualRunState,
  requestPauseContextualRun,
  resumeContextualRun,
  startContextualRun,
  terminateContextualRun,
  useContextualRunProgress,
  useContextualRunState,
} from "@/lib/contextual/run-store"
import { useContextualDraftsSummary } from "@/lib/contextual/drafts-store"
import { installContextualTransport, type ContextualRunRecord } from "@/lib/contextual/transport"
import { useT } from "@/lib/i18n/I18nProvider"
import { AutopilotActivityInspector } from "./AutopilotActivityInspector"
import { ContextualSteering } from "./ContextualSteering"

interface PillProps {
  projectId: string
  fileId: string
  /** Empty string is Project default. Autopilot follows the editor's open lane. */
  activeLane?: string
  /** Server mutations require contributor access. Omitted is fail-closed. */
  canControl?: boolean
  /** SparkleButton idiom: when the backend isn't available the Play button is
   *  never disabled — clicking it opens setup instead. */
  onSetupNeeded?: () => void
  /** Clicking the span label jumps the editor to that passage. */
  onSpanClick?: (spanLabel: string) => void
  /** Cell the user is looking at. Sent on start so the first wave begins
   *  there — same total work, but the first results land on screen. */
  anchorCellId?: string | null
}

const PILL_BASE =
  "pointer-events-auto absolute bottom-4 right-4 z-30 flex items-center gap-2 " +
  "rounded-lg border bg-card px-4 py-2 text-xs ring-1 ring-foreground/10"

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function ContextualRunPill(props: PillProps) {
  return (
    <ContextualRunPillScoped
      key={`${props.projectId}:${props.fileId}:${props.activeLane ?? ""}`}
      {...props}
    />
  )
}

function ContextualRunPillScoped({
  projectId,
  fileId,
  onSetupNeeded,
  onSpanClick,
  anchorCellId,
  canControl = false,
  activeLane = "",
}: PillProps) {
  const t = useT()
  const state = useContextualRunState()
  const storedProgress = useContextualRunProgress()
  const drafts = useContextualDraftsSummary()
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)

  // The store is a single mirror mounted inside one editor. During a React
  // file/lane-switch render the previous scope can remain visible until the
  // attach effect runs; fail closed so that brief window can never expose
  // commands for another file or language lane.
  const belongsToOpenFile =
    state.projectId === projectId &&
    state.fileId === fileId &&
    state.targetLang === activeLane
  const visibleState = belongsToOpenFile ? state : {
    available: false,
    projectId,
    runId: null,
    fileId,
    targetLang: activeLane,
    status: "idle" as const,
    phase: null,
    spanLabel: null,
    activeDirections: [],
    lanes: [],
  }
  const progress = belongsToOpenFile
    ? storedProgress
    : { done: 0, total: 0, failed: 0 }
  const pendingDrafts =
    drafts.projectId === projectId &&
    drafts.fileId === fileId &&
    drafts.targetLang === activeLane
      ? drafts.pending
      : 0
  const { available, status, phase, spanLabel, runId, activeDirections, lanes } = visibleState
  const parkedRemaining = status === "parked"
    ? Math.max(0, progress.total - progress.done - progress.failed)
    : 0
  const inspectorRun = useMemo<ContextualRunRecord | null>(() => runId ? ({
    runId,
    fileId,
    status,
    phase,
    spanLabel,
    done: progress.done,
    total: progress.total,
    failed: progress.failed,
    unitsSpent: 0,
    callsSpent: 0,
    lastError: null,
    createdAt: "",
    updatedAt: "",
    targetLang: activeLane,
    activeDirections,
    proposedDrafts: pendingDrafts,
  }) : null, [activeDirections, activeLane, fileId, pendingDrafts, phase, progress.done, progress.failed, progress.total, runId, spanLabel, status])

  const parkedNeedsAttention = status === "parked" && progress.failed > 0 && parkedRemaining === 0

  // Drafts waiting on a human are the run's RESULT, so they outrank its
  // machinery: a translator wants "12 ready for you", not a span count.
  const pendingChip =
    pendingDrafts > 0 ? (
      <AppTooltip content={t("autopilot.pill.suggestionsWaiting")}>
        <span
          data-testid="contextual-pending-drafts"
          className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary"
          aria-label={t("autopilot.pill.suggestionsReady", { count: pendingDrafts })}
        >
          <Sparkles className="h-3 w-3" aria-hidden />
          <span className="tabular-nums" aria-hidden>{pendingDrafts}</span>
        </span>
      </AppTooltip>
    ) : null

  // A wave runs several passages at once. Naming one of them as "the" passage
  // would be a lie that flickers; report the width instead.
  const laneReadout =
    lanes.length > 1 ? (
      <span data-testid="contextual-lanes" className="text-muted-foreground">
        {t("autopilot.pill.activePassages", { count: lanes.length })}
      </span>
    ) : spanLabel ? (
      <button
        type="button"
        className="max-w-40 truncate underline-offset-2 hover:underline"
        onClick={() => onSpanClick?.(spanLabel)}
      >
        {spanLabel}
      </button>
    ) : null

  // "Direct the run" popover — only meaningful while a run exists to steer
  // (running/pausing/paused/parked); idle, starting, failed and terminated
  // states have nothing listening for directions. Rendered at ONE stable
  // position in a single return so status-frame churn (e.g. a steering wake
  // bouncing parked→running→parked) never unmounts it — an unmount would
  // close the open popover under the user's cursor and drop half-typed text.
  const steerable =
    runId && (status === "running" || status === "pausing" || status === "paused" ||
      status === "parked")
  const steer = canControl && steerable ? (
    <ContextualSteering
      projectId={projectId}
      fileId={fileId}
      runId={runId}
      targetLang={activeLane}
      directions={activeDirections}
    />
  ) : null

  let content: React.ReactNode
  let trailing: React.ReactNode = null
  let pillClass = PILL_BASE
  let announcement = ""
  const localizedPhase = phase === "Reading context…" || phase === "reading"
    ? t("autopilot.phase.reading")
    : phase === "Drafting…" || phase === "drafting"
      ? t("autopilot.phase.drafting")
      : phase === "Checking…" || phase === "checking"
        ? t("autopilot.phase.checking")
        : phase === "Saving drafts…" || phase === "staging"
          ? t("autopilot.phase.staging")
          : null

  if (status === "idle" || status === "terminated") {
    if (status === "terminated") announcement = t("autopilot.feedback.stopped")
    // Idle (no run) and terminated (run is over, can start fresh) share the
    // icon-only Play affordance.
    content = canControl ? (
      <AppTooltip content={t("autopilot.action.run")}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("autopilot.action.run")}
          onClick={() => {
            setControlError(null)
            void (async () => {
              // available starts false until the snapshot lands. Treat that
              // window as hydration, not "backend missing" — otherwise Play
              // opens AI setup instead of starting the run.
              if (!available) {
                await attachContextualRun(projectId, fileId)
                if (!getContextualRunState().available) {
                  onSetupNeeded?.()
                  return
                }
              }
              const started = await startContextualRun(projectId, fileId, anchorCellId ?? undefined, activeLane)
              if (!started) {
                setControlError(t("autopilot.pill.startFailed"))
              }
            })()
          }}
        >
          <Play className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    ) : status === "terminated" ? <span className="text-muted-foreground">{t("autopilot.status.stopped")}</span> : null
  } else if (status === "starting") {
    announcement = t("autopilot.pill.announcement.starting")
    content = (
      <>
        <Spinner className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">{t("autopilot.pill.starting")}</span>
      </>
    )
  } else if (status === "pausing") {
    announcement = t("autopilot.pill.announcement.pausing")
    content = (
      <>
        <Spinner className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">{t("autopilot.pill.finishingPassage")}</span>
      </>
    )
  } else if (status === "paused") {
    announcement = t("autopilot.pill.announcement.paused")
    content = (
      <>
        {canControl && <AppTooltip content={t("autopilot.pill.resumeDrafting")}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("autopilot.pill.resumeDrafting")}
            onClick={() => void resumeContextualRun()}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        </AppTooltip>}
        <span className="text-muted-foreground">{t("autopilot.status.paused")}</span>
        {pendingChip}
        {progress.total > 0 && (
          <span className="tabular-nums text-muted-foreground">
            {progress.done}/{progress.total}
          </span>
        )}
      </>
    )
    trailing = canControl ? (
      <AppTooltip content={t("autopilot.pill.stopRun")}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("autopilot.pill.stopRun")}
          onClick={() => void terminateContextualRun()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    ) : null
  } else if (status === "parked") {
    announcement = parkedRemaining > 0
      ? t("autopilot.pill.announcement.queued", { count: parkedRemaining })
      : parkedNeedsAttention
        ? t("autopilot.pill.announcement.completeWithAttention", {
            done: progress.done,
            total: progress.total,
            failed: progress.failed,
          })
        : t("autopilot.pill.announcement.idle")
    content = (
      <>
        {parkedNeedsAttention
          ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
          : <Eye className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className={parkedNeedsAttention ? undefined : "text-muted-foreground"}>
          {parkedRemaining > 0
            ? t("autopilot.pill.queuedRemaining", { count: parkedRemaining })
            : parkedNeedsAttention
              ? t("autopilot.pill.completeWithAttention", {
                  done: progress.done,
                  total: progress.total,
                  failed: progress.failed,
                })
              : t("autopilot.pill.idle")}
        </span>
        {pendingChip}
      </>
    )
    trailing = canControl ? (
      <AppTooltip content={t("autopilot.pill.stopRun")}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("autopilot.pill.stopRun")}
          onClick={() => void terminateContextualRun()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    ) : null
  } else if (status === "done") {
    announcement = t("autopilot.pill.announcement.complete")
    content = (
      <>
        <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">{t("autopilot.status.complete")}</span>
        {pendingChip}
      </>
    )
    trailing = (
      <AppTooltip content={t("common.dismiss")}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("common.dismiss")}
          onClick={dismissContextualRunSummary}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    )
  } else if (status === "failed") {
    pillClass = cn(PILL_BASE, "border-destructive/40")
    announcement = t("autopilot.pill.announcement.problem")
    content = (
      <>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>
          {progress.failed > 0 && progress.total > 0
            ? t("autopilot.pill.failedPassages", {
                count: progress.total,
                failed: progress.failed,
                total: progress.total,
              })
            : t("autopilot.pill.unexpectedStop")}
        </span>
        {pendingChip}
      </>
    )
    trailing = (
      <AppTooltip content={t("common.dismiss")}>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t("common.dismiss")}
          onClick={dismissContextualRunSummary}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    )
  } else {
    // running
    announcement = t("autopilot.pill.announcement.working")
    content = (
      <>
        {canControl && <AppTooltip content={t("autopilot.pill.pauseAfterPassage")}>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("autopilot.pill.pauseAfterPassage")}
            onClick={() => void requestPauseContextualRun()}
          >
            <Pause className="h-3.5 w-3.5" />
          </Button>
        </AppTooltip>}
        <ProgressBar done={progress.done} total={progress.total} />
        {(localizedPhase || laneReadout) && (
          <span className="flex max-w-56 items-center gap-1 truncate text-muted-foreground">
            {localizedPhase && <span>{localizedPhase}</span>}
            {laneReadout}
          </span>
        )}
        {pendingChip}
        <span className="tabular-nums text-muted-foreground">
          {progress.done}/{progress.total}
        </span>
      </>
    )
  }

  const activityButton = runId ? (
    <AppTooltip content={t("autopilot.pill.viewActivity")}>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t("autopilot.pill.viewActivity")}
        onClick={() => setInspectorOpen(true)}
      >
        <ListTree aria-hidden />
      </Button>
    </AppTooltip>
  ) : null

  if (!content && !activityButton) return null

  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      <div className={pillClass} data-testid="contextual-run-pill">
        {content}
        {steer}
        {activityButton}
        {trailing}
        {controlError && (
          <span role="alert" className="text-destructive">
            {controlError}
          </span>
        )}
      </div>
      <AutopilotActivityInspector
        key={`${projectId}:${fileId}:${activeLane}`}
        projectId={projectId}
        open={inspectorOpen}
        onOpenChange={setInspectorOpen}
        focusRunId={runId}
        focusFileId={fileId}
        fallbackRun={inspectorRun}
        canControl={canControl}
      />
    </>
  )
}

/**
 * Mount wrapper for ProjectWorkspace: hydrates the mirror for the open file
 * and wires span-label clicks to the editor's scroll request. Must render
 * inside EditorScrollProvider (it does — the editor viewport wrapper is).
 */
export function ContextualRunPillMount({ projectId, fileId, activeLane, onSetupNeeded, anchorCellId, canControl }: {
  projectId: string
  fileId: string
  activeLane: string
  canControl: boolean
  onSetupNeeded?: () => void
  anchorCellId?: string | null
}) {
  const { requestScrollToSection } = useEditorScroll()

  useEffect(() => {
    // Slice D2: swap the run-store's stub transport for the real auth-worker
    // client before the first snapshot fetch. Idempotent (first call wins).
    installContextualTransport()
    void attachContextualRun(projectId, fileId, activeLane)
  }, [activeLane, projectId, fileId])

  return (
    <ContextualRunPill
      projectId={projectId}
      fileId={fileId}
      activeLane={activeLane}
      onSetupNeeded={onSetupNeeded}
      anchorCellId={anchorCellId}
      canControl={canControl}
      onSpanClick={(label) => requestScrollToSection(label, fileId)}
    />
  )
}
