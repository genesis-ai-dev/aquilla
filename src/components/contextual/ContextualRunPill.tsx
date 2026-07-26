// Floating play/pause pill for the contextual drafting run (design §10 of the
// contextual-translation-pipeline spec). Renders inside the editor viewport
// wrapper at `absolute bottom-4 right-4 z-30` (the floating-chip layer per
// AppShell's z-scale) so it disappears automatically on non-editor surfaces.
//
// The pill is a live readout of the run-store MIRROR — the run itself is a
// durable server-side workflow; closing the tab changes nothing. All strings
// here are plain user words (ui-jargon-guard.test.ts bans spec ids).

import { useEffect } from "react"
import { AlertTriangle, Eye, Loader2, Pause, Play, X } from "lucide-react"
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
import { installContextualTransport } from "@/lib/contextual/transport"

interface PillProps {
  projectId: string
  fileId: string
  /** SparkleButton idiom: when the backend isn't available the Play button is
   *  never disabled — clicking it opens setup instead. */
  onSetupNeeded?: () => void
  /** Clicking the span label jumps the editor to that passage. */
  onSpanClick?: (spanLabel: string) => void
}

const PILL_BASE =
  "pointer-events-auto absolute bottom-4 right-4 z-30 flex items-center gap-2 " +
  "rounded-full border bg-card px-4 py-2 text-xs ring-1 ring-foreground/10"

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function ContextualRunPill({ projectId, fileId, onSetupNeeded, onSpanClick }: PillProps) {
  const state = useContextualRunState()
  const progress = useContextualRunProgress()

  const { available, status, phase, spanLabel } = state

  // Idle (no run) and terminated (run is over, can start fresh) share the
  // icon-only Play affordance.
  if (status === "idle" || status === "terminated") {
    return (
      <div className={PILL_BASE} data-testid="contextual-run-pill">
        <AppTooltip content="Contextual draft">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Contextual draft"
            onClick={() => {
              if (!available) { onSetupNeeded?.(); return }
              void startContextualRun(projectId, fileId)
            }}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        </AppTooltip>
      </div>
    )
  }

  if (status === "starting") {
    return (
      <div className={PILL_BASE} data-testid="contextual-run-pill">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Starting…</span>
      </div>
    )
  }

  if (status === "pausing") {
    return (
      <div className={PILL_BASE} data-testid="contextual-run-pill">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Finishing this passage…</span>
      </div>
    )
  }

  if (status === "paused") {
    return (
      <div className={PILL_BASE} data-testid="contextual-run-pill">
        <AppTooltip content="Resume drafting">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Resume drafting"
            onClick={() => void resumeContextualRun()}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        </AppTooltip>
        <span className="text-muted-foreground">Paused</span>
        {progress.total > 0 && (
          <span className="tabular-nums text-muted-foreground">
            {progress.done}/{progress.total}
          </span>
        )}
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
      </div>
    )
  }

  if (status === "parked" || status === "done") {
    return (
      <div className={PILL_BASE} data-testid="contextual-run-pill">
        <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Watching for changes</span>
        <AppTooltip content="Stop watching">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Stop watching"
            onClick={() => void terminateContextualRun()}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </AppTooltip>
      </div>
    )
  }

  if (status === "failed") {
    return (
      <div
        className={cn(PILL_BASE, "border-destructive/40")}
        data-testid="contextual-run-pill"
        role="status"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span>
          {progress.failed > 0 && progress.total > 0
            ? `${progress.failed} of ${progress.total} passages had problems`
            : "Drafting stopped unexpectedly"}
        </span>
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
      </div>
    )
  }

  // running
  return (
    <div className={PILL_BASE} data-testid="contextual-run-pill">
      <AppTooltip content="Pause after this passage">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Pause after this passage"
          onClick={() => void requestPauseContextualRun()}
        >
          <Pause className="h-3.5 w-3.5" />
        </Button>
      </AppTooltip>
      <ProgressBar done={progress.done} total={progress.total} />
      {(phase || spanLabel) && (
        <span className="max-w-48 truncate text-muted-foreground">
          {phase}
          {phase && spanLabel ? " · " : ""}
          {spanLabel && (
            <button
              type="button"
              className="cursor-pointer underline-offset-2 hover:underline"
              onClick={() => onSpanClick?.(spanLabel)}
            >
              {spanLabel}
            </button>
          )}
        </span>
      )}
      <span className="tabular-nums text-muted-foreground">
        {progress.done}/{progress.total}
      </span>
    </div>
  )
}

/**
 * Mount wrapper for ProjectWorkspace: hydrates the mirror for the open file
 * and wires span-label clicks to the editor's scroll request. Must render
 * inside EditorScrollProvider (it does — the editor viewport wrapper is).
 */
export function ContextualRunPillMount({ projectId, fileId, onSetupNeeded }: {
  projectId: string
  fileId: string
  onSetupNeeded?: () => void
}) {
  const { requestScrollToSection } = useEditorScroll()

  useEffect(() => {
    // Slice D2: swap the run-store's stub transport for the real auth-worker
    // client before the first snapshot fetch. Idempotent (first call wins).
    installContextualTransport()
    void attachContextualRun(projectId, fileId)
  }, [projectId, fileId])

  return (
    <ContextualRunPill
      projectId={projectId}
      fileId={fileId}
      onSetupNeeded={onSetupNeeded}
      onSpanClick={(label) => requestScrollToSection(label, fileId)}
    />
  )
}
