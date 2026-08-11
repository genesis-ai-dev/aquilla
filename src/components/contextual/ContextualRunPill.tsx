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
  requestPauseContextualRun,
  resumeContextualRun,
  startContextualRun,
  terminateContextualRun,
  useContextualRunProgress,
  useContextualRunState,
} from "@/lib/contextual/run-store"
import { useContextualDraftsSummary } from "@/lib/contextual/drafts-store"
import { installContextualTransport, type ContextualRunRecord } from "@/lib/contextual/transport"
import { AutopilotActivityInspector } from "./AutopilotActivityInspector"
import { ContextualSteering } from "./ContextualSteering"

interface PillProps {
  projectId: string
  fileId: string
  /** Empty string is Project default. v1 does not operate in other lanes. */
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
  const state = useContextualRunState()
  const storedProgress = useContextualRunProgress()
  const drafts = useContextualDraftsSummary()
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [controlError, setControlError] = useState<string | null>(null)

  // The store is a single mirror mounted inside one editor. During a React
  // file-switch render the previous file can remain visible until the attach
  // effect runs; fail closed so that brief window can never expose commands
  // for another file's run.
  const belongsToOpenFile = state.projectId === projectId && state.fileId === fileId
  const visibleState = belongsToOpenFile ? state : {
    available: false,
    projectId,
    runId: null,
    fileId,
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
    drafts.targetLang === ""
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
    activeDirections,
    proposedDrafts: pendingDrafts,
  }) : null, [activeDirections, fileId, pendingDrafts, phase, progress.done, progress.failed, progress.total, runId, spanLabel, status])

  // Autopilot v1 is deliberately default-lane-only. Do not leave a hidden
  // default run's controls or inspector mounted while edits commit into a
  // multilingual lane; show the boundary in plain language instead.
  if (activeLane !== "") {
    return (
      <div className={PILL_BASE} data-testid="contextual-run-pill" role="status">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">
          Autopilot works in Project default only. Switch to that lane to run it.
        </span>
      </div>
    )
  }

  // Drafts waiting on a human are the run's RESULT, so they outrank its
  // machinery: a translator wants "12 ready for you", not a span count.
  const pendingChip =
    pendingDrafts > 0 ? (
      <AppTooltip content="Suggestions waiting in your cells">
        <span
          data-testid="contextual-pending-drafts"
          className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary"
        >
          <Sparkles className="h-3 w-3" aria-hidden />
          <span className="tabular-nums">{pendingDrafts}</span>
          <span className="sr-only"> suggestions ready to review</span>
        </span>
      </AppTooltip>
    ) : null

  // A wave runs several passages at once. Naming one of them as "the" passage
  // would be a lie that flickers; report the width instead.
  const laneReadout =
    lanes.length > 1 ? (
      <span data-testid="contextual-lanes" className="text-muted-foreground">
        {lanes.length} passages
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
      directions={activeDirections}
    />
  ) : null

  let content: React.ReactNode
  let trailing: React.ReactNode = null
  let pillClass = PILL_BASE
  let announcement = ""

  if (status === "idle" || status === "terminated") {
    if (status === "terminated") announcement = "Autopilot stopped."
    // Idle (no run) and terminated (run is over, can start fresh) share the
    // icon-only Play affordance.
    content = canControl ? (
      <AppTooltip content="Run Autopilot">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Run Autopilot"
          onClick={() => {
            setControlError(null)
            if (!available) { onSetupNeeded?.(); return }
            void startContextualRun(projectId, fileId, anchorCellId ?? undefined).then((started) => {
              if (!started) {
                setControlError("Autopilot couldn’t start. Try again or check AI setup.")
              }
            })
          }}
        >
          <Play className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    ) : status === "terminated" ? <span className="text-muted-foreground">Stopped</span> : null
  } else if (status === "starting") {
    announcement = "Autopilot is starting."
    content = (
      <>
        <Spinner className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Starting…</span>
      </>
    )
  } else if (status === "pausing") {
    announcement = "Autopilot will pause after the current passage."
    content = (
      <>
        <Spinner className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Finishing this passage…</span>
      </>
    )
  } else if (status === "paused") {
    announcement = "Autopilot paused."
    content = (
      <>
        {canControl && <AppTooltip content="Resume drafting">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Resume drafting"
            onClick={() => void resumeContextualRun()}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        </AppTooltip>}
        <span className="text-muted-foreground">Paused</span>
        {pendingChip}
        {progress.total > 0 && (
          <span className="tabular-nums text-muted-foreground">
            {progress.done}/{progress.total}
          </span>
        )}
      </>
    )
    trailing = canControl ? (
      <AppTooltip content="Stop this run">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Stop this run"
          onClick={() => void terminateContextualRun()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    ) : null
  } else if (status === "parked") {
    announcement = parkedRemaining > 0
      ? `Autopilot has ${parkedRemaining} ${parkedRemaining === 1 ? "passage" : "passages"} queued and will continue in the background.`
      : "Autopilot is idle. No work is queued."
    content = (
      <>
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {parkedRemaining > 0
            ? `Queued · ${parkedRemaining} ${parkedRemaining === 1 ? "passage" : "passages"} remaining`
            : "Idle · no work queued"}
        </span>
        {pendingChip}
      </>
    )
    trailing = canControl ? (
      <AppTooltip content="Stop this run">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Stop this run"
          onClick={() => void terminateContextualRun()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    ) : null
  } else if (status === "done") {
    announcement = "Autopilot completed."
    content = (
      <>
        <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Complete</span>
        {pendingChip}
      </>
    )
    trailing = (
      <AppTooltip content="Dismiss">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={dismissContextualRunSummary}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    )
  } else if (status === "failed") {
    pillClass = cn(PILL_BASE, "border-destructive/40")
    announcement = "Autopilot stopped after a problem."
    content = (
      <>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>
          {progress.failed > 0 && progress.total > 0
            ? `${progress.failed} of ${progress.total} passages had problems`
            : "Drafting stopped unexpectedly"}
        </span>
        {pendingChip}
      </>
    )
    trailing = (
      <AppTooltip content="Dismiss">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={dismissContextualRunSummary}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
    )
  } else {
    // running
    announcement = "Autopilot is working."
    content = (
      <>
        {canControl && <AppTooltip content="Pause after this passage">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Pause after this passage"
            onClick={() => void requestPauseContextualRun()}
          >
            <Pause className="h-3.5 w-3.5" />
          </Button>
        </AppTooltip>}
        <ProgressBar done={progress.done} total={progress.total} />
        {(phase || laneReadout) && (
          <span className="flex max-w-56 items-center gap-1 truncate text-muted-foreground">
            {phase}
            {phase && laneReadout ? " · " : ""}
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
    <AppTooltip content="View Autopilot activity">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="View Autopilot activity"
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
    if (activeLane !== "") return
    // Slice D2: swap the run-store's stub transport for the real auth-worker
    // client before the first snapshot fetch. Idempotent (first call wins).
    installContextualTransport()
    void attachContextualRun(projectId, fileId)
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
