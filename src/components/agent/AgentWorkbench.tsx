/**
 * AgentWorkbench.tsx — the editor's three-pane Source | Agent | Target surface.
 *
 * Surface ownership (agent-mode-v2 review-loop redesign): the chat is a
 * NARROW RAIL that narrates — proposals render there as compact receipts
 * with live counters — and the working set is the single review surface,
 * with draft text editable in place before accepting. Accept commits what's
 * in the box (the human post-edits the machine draft), through the same
 * staged-apply outbox path as ever. A job header shows bulk-run progress
 * with Stop, plus session controls (new session, back to editor).
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bot, Minimize2, RotateCcw, Square } from "lucide-react"
import type { Layout } from "react-resizable-panels"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { AppTooltip } from "@/components/ui/tooltip"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { applyStagedEvents, type ApplyContext } from "@/lib/agent/apply"
import type { AgentProposal } from "@/lib/agent/protocol"
import { useAgentSession } from "@/lib/agent/session-store"
import { applyCellScrollAnchor, readCellScrollAnchor } from "@/lib/agent/synchronized-scroll"
import { buildUndoEvents } from "@/lib/agent/undo"
import { readAgentWorkbenchLayout, writeAgentWorkbenchLayout } from "@/lib/agent/workbench-layout"
import type { TargetPresenceSelection } from "@/lib/sync/presence-store"
import type { TranslatedEditorCommit } from "../TranslatedEditor"
import {
  deriveWorkingSet,
  pendingRows,
  proposalRowKey,
  type RowDecision,
  type WorkingSetRow,
} from "@/lib/agent/working-set"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { AgentDockView, type AgentDockViewProps } from "./AgentDockView"
import { AgentContextPane, type AgentWorkbenchCell } from "./AgentContextPane"
import { CreditsDial, type CreditsDialProps } from "./CreditsDial"
import { lintCellFor } from "./ProposalCard"
import { ProposalReceipt } from "./ProposalReceipt"
import { WorkingSetPanel, type WorkingSetPanelHandle } from "./WorkingSetPanel"

// Memory tab (AQU-AGENT §5): owned by W1E, may not exist in this worktree —
// lazy import so a missing module only fails when the tab is opened, not at
// build time. If W1E's file isn't present yet, fall back to the local
// SWARM-TODO stub in ./memory/AgentMemoryTab.tsx.
const AgentMemoryTab = lazy(() => import("./memory/AgentMemoryTab"))

type WorkbenchTab = "sessions" | "memory"

export interface AgentWorkbenchProps {
  /** Same wiring the dock panel gets — one source of truth in ProjectWorkspace. */
  agent: Omit<AgentDockViewProps, "suggestedActions" | "pendingPrompt" | "onPendingPromptConsumed">
  /** Org agent-credit gauge in the header (maintainer+ only; self-hides). */
  credits?: CreditsDialProps | null
  /** Minimize to the dock and dismiss the editor Agent tab. */
  onClose: () => void
  /** Jump the editor to a cell ("open" on a working-set row). */
  onJumpToCell?: (fileId: string, cellId: string) => void
  /** Reveal the file explorer while remaining in Agent mode. */
  onChooseFile?: () => void
  /** Live document context flanking the Agent pane. */
  workspace?: {
    cells: AgentWorkbenchCell[]
    fileName?: string | null
    sourceLanguage?: string | null
    targetLanguage?: string | null
    focusedCellId?: string | null
    totalCells?: number
    scopeAvailable?: boolean
    loading?: boolean
    editable?: boolean
    onCommitTarget?: (cellId: string, snapshot: TranslatedEditorCommit) => void | Promise<void>
    isAnonymous?: boolean
    isCompletionConfigured?: boolean
    isCompletionAvailable?: boolean
    completing?: ReadonlyMap<string, string>
    onDraftTarget?: (cellId: string, options?: { regenerate?: boolean }) => void | boolean | Promise<boolean>
    onAiSetupNeeded?: () => void
    openCommentCounts?: ReadonlyMap<string, number>
    onOpenComments?: (cellId: string) => void
    onOpenHistory?: (cellId: string) => void
    currentUsername?: string
    validationRequirement?: number
    canValidate?: boolean
    onValidationChange?: (cellId: string, validated: boolean) => unknown
    cellLockHolders?: ReadonlyMap<string, string>
    onClaimCell?: (cellId: string) => void
    onReleaseCell?: (cellId: string) => void
    onTargetPresenceSelection?: (cellId: string, selection: TargetPresenceSelection | null) => void
    onVisibleCellIdsChange?: (cellIds: string[]) => void
  }
}

export function AgentWorkbench({ agent, credits, onClose, onJumpToCell, onChooseFile, workspace }: AgentWorkbenchProps) {
  const { state, stop, reset, decide } = useAgentSession(agent.projectId)
  // Decisions per proposal row (key: proposalId:cellId) live in the SESSION
  // store, not here — closing/reopening the workbench must not forget what
  // was applied (that would re-offer applied drafts and drop Undo).
  const decided = state.decided
  const [applying, setApplying] = useState(false)
  const [tab, setTab] = useState<WorkbenchTab>("sessions")
  const panelRef = useRef<WorkingSetPanelHandle>(null)
  const sourceScrollRef = useRef<HTMLDivElement>(null)
  const targetScrollRef = useRef<HTMLDivElement>(null)
  const scrollSourceRef = useRef<"source" | "target" | null>(null)
  const initialLayout = useMemo(() => readAgentWorkbenchLayout(agent.projectId), [agent.projectId])

  const rows = useMemo(() => deriveWorkingSet(state.runs, decided), [state.runs, decided])
  const pending = useMemo(() => pendingRows(rows), [rows])
  // The stage exists for REVIEW: staged drafts awaiting a decision, or the
  // record of decisions made. Read-only sightings live in chat as passage
  // cards — mirroring them into a grid is the double-display the
  // agent-complete redesign removed.
  const stageRows = useMemo(
    () => rows.filter((r) => (r.proposed !== undefined && r.stagedEvent) || r.outcome),
    [rows],
  )
  const hasReviewWork = stageRows.length > 0
  const workspaceCellsById = useMemo(
    () => new Map((workspace?.cells ?? []).map((cell) => [cell.cellId, cell])),
    [workspace?.cells],
  )
  const contextCells = useMemo<AgentWorkbenchCell[]>(
    () => hasReviewWork
      ? stageRows.map((row) => {
          const live = workspaceCellsById.get(row.cellId)
          const source = row.source ?? live?.source ?? ""
          const target = row.target ?? live?.target ?? ""
          return {
            ...live,
            cellId: row.cellId,
            fileId: row.fileId ?? live?.fileId ?? "",
            ref: row.ref ?? live?.ref,
            source,
            // A staged/read sighting may carry newer plain text than the live
            // workspace. Never render stale rich HTML over that newer value.
            sourceHtml: source === live?.source ? live?.sourceHtml : undefined,
            target,
            targetHtml: target === live?.target ? live?.targetHtml : undefined,
            status: row.status ?? live?.status,
          }
        })
      : workspace?.cells ?? [],
    [hasReviewWork, stageRows, workspace?.cells, workspaceCellsById],
  )
  const contextCellIdsKey = contextCells.map((cell) => cell.cellId).join("\u0000")

  useEffect(() => {
    const onVisibleCellIdsChange = workspace?.onVisibleCellIdsChange
    if (!onVisibleCellIdsChange) return
    if (hasReviewWork) {
      onVisibleCellIdsChange([])
      return
    }
    const root = targetScrollRef.current
    if (!root) {
      onVisibleCellIdsChange([])
      return
    }
    const report = () => {
      const viewport = root.getBoundingClientRect()
      const ids = Array.from(root.querySelectorAll<HTMLElement>("article[data-cell-id]"))
        .filter((row) => {
          const rect = row.getBoundingClientRect()
          return rect.bottom > viewport.top && rect.top < viewport.bottom
        })
        .map((row) => row.dataset.cellId)
        .filter((cellId): cellId is string => Boolean(cellId))
      onVisibleCellIdsChange(ids)
    }
    report()
    const frame = requestAnimationFrame(report)
    root.addEventListener("scroll", report, { passive: true })
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(report)
      : null
    resizeObserver?.observe(root)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener("scroll", report)
      resizeObserver?.disconnect()
      onVisibleCellIdsChange([])
    }
  }, [contextCellIdsKey, hasReviewWork, workspace?.onVisibleCellIdsChange])

  const activeRun = state.runs.find((r) => r.status === "running")
  const progress = activeRun?.progress

  const applyContext: ApplyContext = useMemo(
    () => ({
      projectId: agent.projectId,
      author: agent.author,
      resolveCell: agent.resolveCell
        ? (cellId) => {
            const cell = agent.resolveCell!(cellId)
            return cell
              ? { targetEventId: cell.targetEventId, sourceEventId: cell.sourceEventId }
              : undefined
          }
        : undefined,
    }),
    [agent.projectId, agent.author, agent.resolveCell],
  )

  // ── Rule lint (same engine as the editor / ProposalCard) ────────────────
  const enabledRules = useMemo(() => agent.rules.filter((r) => r.enabled), [agent.rules])
  const lintRow = useCallback(
    (row: WorkingSetRow, text: string): string[] => {
      if (!row.stagedEvent || enabledRules.length === 0) return []
      const cell = lintCellFor(row.stagedEvent, agent.resolveCell, text)
      return checkRulesForCell(cell, row.stagedEvent.fileId ?? row.fileId ?? "", enabledRules).map(
        (inf) => inf.message,
      )
    },
    [enabledRules, agent.resolveCell],
  )

  // ── Accept / reject ──────────────────────────────────────────────────────
  const acceptRows = useCallback(
    async (toApply: { row: WorkingSetRow; value: string }[]) => {
      const staged = toApply.filter(({ row }) => row.stagedEvent && row.proposalId)
      if (staged.length === 0) return
      // Accept commits what's in the box: clone each staged event with the
      // (possibly edited) text before it goes through the apply path.
      const events = staged.map(({ row, value }) => ({
        ...row.stagedEvent!,
        payload: { ...row.stagedEvent!.payload, value },
        display: { ...row.stagedEvent!.display, after: value },
      }))
      setApplying(true)
      try {
        const eventIds = await applyStagedEvents(events, applyContext)
        decide(
          staged.map(({ row, value }, i): [string, RowDecision] => [
            proposalRowKey(row.proposalId!, row.cellId),
            {
              outcome: value === row.proposed ? "accepted" : "edited",
              value,
              // The undo path's chain-head guard: undo only while this is
              // still the cell's winning head.
              appliedEventId: eventIds[i],
            },
          ]),
        )
        await agent.onApplied?.(eventIds, staged.map(({ row }) => row.cellId))
      } finally {
        setApplying(false)
      }
    },
    [applyContext, agent, decide],
  )

  // ── Undo (compensation, not deletion): emit commits restoring each
  //    accepted row's pre-run value through the SAME apply path. Rows whose
  //    chain head moved on since the accept are skipped, not clobbered.
  const undoProposal = useCallback(
    async (proposal: AgentProposal) => {
      const plan = buildUndoEvents(proposal, decided, (cellId) =>
        agent.resolveCell?.(cellId)?.targetEventId,
      )
      if (plan.events.length === 0) return
      setApplying(true)
      try {
        const eventIds = await applyStagedEvents(plan.events, applyContext)
        decide(
          plan.cellIds.map((cellId, i): [string, RowDecision] => [
            proposalRowKey(proposal.proposalId, cellId),
            {
              outcome: "undone",
              value: plan.restoredValues.get(cellId),
              appliedEventId: eventIds[i],
            },
          ]),
        )
        await agent.onApplied?.(eventIds, plan.cellIds)
      } finally {
        setApplying(false)
      }
    },
    [decided, applyContext, agent, decide],
  )

  const rejectRow = useCallback(
    (row: WorkingSetRow) => {
      if (!row.proposalId) return
      decide([[proposalRowKey(row.proposalId, row.cellId), { outcome: "rejected" }]])
    },
    [decide],
  )

  // ── Receipt rendering (chat shows counters, not a second diff) ──────────
  const renderProposalOverride = useCallback(
    (proposal: AgentProposal) => {
      const commits = proposal.events.filter((ev) => ev.kind === "target.cell.commit" && ev.cellId)
      // Mixed/non-commit proposals aren't reviewable in the grid — fall back
      // to the full card (returning null does that).
      if (commits.length === 0 || commits.length !== proposal.events.length) return null
      let accepted = 0
      let edited = 0
      let rejected = 0
      let undone = 0
      let pendingCount = 0
      let checks = 0
      for (const ev of commits) {
        const decision = decided.get(proposalRowKey(proposal.proposalId, ev.cellId!))
        if (!decision) {
          pendingCount++
          if (enabledRules.length > 0) {
            checks += checkRulesForCell(
              lintCellFor(ev, agent.resolveCell),
              ev.fileId ?? "",
              enabledRules,
            ).length
          }
        } else if (decision.outcome === "accepted") accepted++
        else if (decision.outcome === "edited") edited++
        else if (decision.outcome === "undone") undone++
        else rejected++
      }
      return (
        <ProposalReceipt
          key={proposal.proposalId}
          proposal={proposal}
          counts={{ accepted, edited, rejected, undone, pending: pendingCount, checks }}
          onReview={() => panelRef.current?.focusFirstPending()}
          onUndo={applying ? undefined : () => undoProposal(proposal)}
        />
      )
    },
    [decided, enabledRules, agent.resolveCell, applying, undoProposal],
  )

  const handleLayoutChanged = useCallback((layout: Layout) => {
    writeAgentWorkbenchLayout(agent.projectId, layout)
  }, [agent.projectId])

  const synchronizeScroll = useCallback((from: "source" | "target", container: HTMLDivElement) => {
    if (scrollSourceRef.current && scrollSourceRef.current !== from) {
      scrollSourceRef.current = null
      return
    }
    const destination = from === "source" ? targetScrollRef.current : sourceScrollRef.current
    const anchor = readCellScrollAnchor(container)
    if (!destination || !anchor) return
    scrollSourceRef.current = from
    applyCellScrollAnchor(destination, anchor)
    requestAnimationFrame(() => {
      if (scrollSourceRef.current === from) scrollSourceRef.current = null
    })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        value={tab}
        onValueChange={(next) => setTab(next as WorkbenchTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        {/* One compact workbench header: identity, navigation, and actions. */}
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-sm font-medium">Agent</span>
          {activeRun && (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
              <Spinner className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {progress ? `${progress.label} — ${progress.done}/${progress.total}` : "working…"}
              </span>
            </span>
          )}
          {state.queued.length > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{state.queued.length} queued</span>
          )}

          <TabsList
            variant="line"
            className="h-7 w-fit shrink-0 p-0"
            aria-label="Agent workbench sections"
          >
            <TabsTrigger value="sessions" className="h-full px-2 text-xs">
              Chat
            </TabsTrigger>
            <TabsTrigger value="memory" className="h-full px-2 text-xs">
              Project knowledge
            </TabsTrigger>
          </TabsList>

          <span className="ml-auto flex shrink-0 items-center gap-1">
            {credits && <CreditsDial {...credits} />}
            {state.isStreaming && (
              <Button type="button" variant="outline" size="sm" className="h-6 text-[11px]" onClick={stop}>
                <Square data-icon="inline-start" />
                Stop
              </Button>
            )}
            <AppTooltip content="Drop this conversation and start a fresh session">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] text-muted-foreground"
                onClick={reset}
              >
                <RotateCcw data-icon="inline-start" />
                New session
              </Button>
            </AppTooltip>
            <AppTooltip content="Collapse the Agent pane">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 text-[11px] text-muted-foreground"
                onClick={onClose}
                aria-label="Collapse Agent pane"
              >
                <Minimize2 data-icon="inline-start" />
                Collapse
              </Button>
            </AppTooltip>
          </span>
        </div>

        <TabsContent value="sessions" className="flex min-h-0 flex-1 flex-col">
          <ResizablePanelGroup
            id={`agent-workbench-${agent.projectId}`}
            orientation="horizontal"
            defaultLayout={initialLayout}
            onLayoutChanged={handleLayoutChanged}
            className="min-h-0 flex-1"
          >
            <ResizablePanel id="source" minSize="16%">
              <AgentContextPane
                kind="source"
                cells={contextCells}
                language={workspace?.sourceLanguage}
                fileName={workspace?.fileName}
                totalCells={hasReviewWork ? contextCells.length : workspace?.totalCells}
                focusedCellId={workspace?.focusedCellId}
                scopeAvailable={workspace?.scopeAvailable}
                loading={workspace?.loading}
                onChooseFile={onChooseFile}
                scrollContainerRef={sourceScrollRef}
                onScroll={(event) => synchronizeScroll("source", event.currentTarget)}
              />
            </ResizablePanel>

            <ResizableHandle aria-label="Resize source and Agent panes" className="bg-border/70 hover:bg-primary/40" />

            <ResizablePanel
              id="agent"
              minSize="24%"
              collapsible
              collapsedSize={0}
              onResize={(size, _id, previousSize) => {
                if (previousSize && previousSize.inPixels > 0 && size.inPixels === 0) onClose()
              }}
            >
              <section aria-label="Agent pane" className="flex h-full min-h-0 flex-col bg-background">
                <div className="flex h-9 shrink-0 items-center border-b border-border/70 px-3">
                  <span className="text-[11px] font-semibold tracking-tight text-foreground/90">Agent</span>
                  <AppTooltip content="Minimize Agent">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto h-6 w-6 rounded-md text-muted-foreground hover:text-foreground"
                      onClick={onClose}
                      aria-label="Minimize Agent"
                    >
                      <Minimize2 className="h-3.5 w-3.5" />
                    </Button>
                  </AppTooltip>
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <AgentDockView
                    {...agent}
                    renderProposalOverride={renderProposalOverride}
                    onReviewMemory={() => setTab("memory")}
                  />
                </div>
              </section>
            </ResizablePanel>

            <ResizableHandle aria-label="Resize Agent and target panes" className="bg-border/70 hover:bg-primary/40" />

            <ResizablePanel id="target" minSize="16%">
              {hasReviewWork ? (
                <div className="h-full min-h-0">
                  <WorkingSetPanel
                    ref={panelRef}
                    rows={stageRows}
                    showSource={false}
                    title="Target"
                    language={workspace?.targetLanguage}
                    busy={applying}
                    lintRow={lintRow}
                    onAccept={(row, value) => acceptRows([{ row, value }])}
                    onAcceptAll={(valueFor) =>
                      acceptRows(pending.map((row) => ({ row, value: valueFor(row) })))
                    }
                    onReject={rejectRow}
                    onJumpToCell={onJumpToCell}
                  />
                </div>
              ) : (
                <AgentContextPane
                  kind="target"
                  cells={contextCells}
                  language={workspace?.targetLanguage}
                  fileName={workspace?.fileName}
                  totalCells={workspace?.totalCells}
                  focusedCellId={workspace?.focusedCellId}
                  scopeAvailable={workspace?.scopeAvailable}
                  loading={workspace?.loading}
                  onChooseFile={onChooseFile}
                  scrollContainerRef={targetScrollRef}
                  onScroll={(event) => synchronizeScroll("target", event.currentTarget)}
                  editable={workspace?.editable}
                  onCommitTarget={workspace?.onCommitTarget}
                  isAnonymous={workspace?.isAnonymous}
                  isCompletionConfigured={workspace?.isCompletionConfigured}
                  isCompletionAvailable={workspace?.isCompletionAvailable}
                  completing={workspace?.completing}
                  onDraftTarget={workspace?.onDraftTarget}
                  onAiSetupNeeded={workspace?.onAiSetupNeeded}
                  openCommentCounts={workspace?.openCommentCounts}
                  onOpenComments={workspace?.onOpenComments}
                  onOpenHistory={workspace?.onOpenHistory}
                  currentUsername={workspace?.currentUsername}
                  validationRequirement={workspace?.validationRequirement}
                  canValidate={workspace?.canValidate}
                  onValidationChange={workspace?.onValidationChange}
                  cellLockHolders={workspace?.cellLockHolders}
                  onClaimCell={workspace?.onClaimCell}
                  onReleaseCell={workspace?.onReleaseCell}
                  onTargetPresenceSelection={workspace?.onTargetPresenceSelection}
                />
              )}
            </ResizablePanel>
          </ResizablePanelGroup>
        </TabsContent>

        <TabsContent value="memory" className="min-h-0 flex-1 overflow-auto">
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-1.5 p-6 text-xs text-muted-foreground">
                <Spinner className="h-3.5 w-3.5" />
                Loading memory…
              </div>
            }
          >
            <AgentMemoryTab projectId={agent.projectId} roleLevel={agent.roleLevel ?? null} />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  )
}
