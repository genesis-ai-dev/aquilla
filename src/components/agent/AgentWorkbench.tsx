/**
 * One URL-driven conversation workspace, with optional document, proposal
 * review, and knowledge views. Chat proposals retain the staged-apply outbox
 * and compensating Undo paths; contextual tasks retain their own review gate.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowLeft, Minimize2, Square } from "lucide-react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AppTooltip } from "@/components/ui/tooltip"
import { EditorModeToggle, type EditorLens } from "@/components/EditorModeToggle"
import {
  EDITOR_SURFACE_OVERFLOW_TRIGGER_CLASS,
  EDITOR_SURFACE_TOOLBAR_CLASS,
} from "@/components/editor-surface-toolbar"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import { applyStagedEvents, type ApplyContext } from "@/lib/agent/apply"
import type { AgentProposal } from "@/lib/agent/protocol"
import { useAgentSession } from "@/lib/agent/session-store"
import { buildUndoEvents } from "@/lib/agent/undo"
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
import { formatInfractionMessage } from "@/lib/rules/format-infraction"
import { translateRuleName } from "@/lib/lqa/builtin-resolver"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import { CONVERSATION_PARAM, TEAM_CHAT_CONVERSATION } from "@/lib/agent/team-channel"
import { readAgentWorkspaceView, type AgentWorkspaceView } from "@/lib/agent/workspace-location"
import { AgentDockView, type AgentDockViewProps } from "./AgentDockView"
import { AgentChatOptions } from "./AgentChatOptions"
import type { AgentWorkbenchCell } from "./AgentContextPane"
import { AgentDocumentContext } from "./AgentDocumentContext"
import { TeamThreadsView } from "./TeamThreadsView"
import { TeamChannel, type TeamChannelProps } from "./TeamChannel"
import { CreditsDial, type CreditsDialProps } from "./CreditsDial"
import { lintCellFor } from "./ProposalCard"
import { ProposalReceipt } from "./ProposalReceipt"
import { WorkingSetPanel, type WorkingSetPanelHandle } from "./WorkingSetPanel"

// Memory tab (AQU-AGENT §5): owned by W1E, may not exist in this worktree —
// lazy import so a missing module only fails when the tab is opened, not at
// build time. If W1E's file isn't present yet, fall back to the local
// SWARM-TODO stub in ./memory/AgentMemoryTab.tsx.
const AgentMemoryTab = lazy(() => import("./memory/AgentMemoryTab"))

export interface AgentWorkbenchProps {
  /** One source of truth in ProjectWorkspace. `pendingPrompt` rides along so
   *  dock quick actions (Summarize book/chapter) run in this surface's chat. */
  agent: Omit<AgentDockViewProps, "suggestedActions">
  /** Org agent-credit gauge in the header (maintainer+ only; self-hides). */
  credits?: CreditsDialProps | null
  /** File display names for the Team tab's thread titles. */
  fileNames?: ReadonlyMap<string, string>
  /** Return destination; following it leaves the Agent tab available. */
  editorHref: string
  /** Header Collapse — only when the workbench was expanded from the sidebar dock. */
  onCollapse?: () => void
  /** Jump the editor to a cell ("open" on a working-set row). */
  onJumpToCell?: (fileId: string, cellId: string) => void
  /** Reveal the file explorer while remaining in Agent mode. */
  onChooseFile?: () => void
  /** Text / Audio / Agent switch — same control as the editor chapter row. */
  editorMode?: {
    lens: EditorLens
    timeOrdered?: boolean
    onLensChange: (lens: EditorLens) => void
  }
  /** File-identity ⋯ (rename / move / export / delete). Editor-only tools stay off this surface. */
  fileMenuItems?: OverflowMenuItem[]
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
    onViewCell?: (cellId: string | null) => void
    onTargetPresenceSelection?: (cellId: string, selection: TargetPresenceSelection | null) => void
    onVisibleCellIdsChange?: (cellIds: string[]) => void
  }
}

export function AgentWorkbench({ agent, credits, fileNames, editorHref, onCollapse, onJumpToCell, onChooseFile, editorMode, fileMenuItems, workspace }: AgentWorkbenchProps) {
  const t = useT()
  const { state, stop, reset, decide } = useAgentSession(agent.projectId, agent.author)
  // Decisions per proposal row (key: proposalId:cellId) live in the SESSION
  // store, not here — closing/reopening the workbench must not forget what
  // was applied (that would re-offer applied drafts and drop Undo).
  const decided = state.decided
  const [applying, setApplying] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const conversationId = searchParams.get(CONVERSATION_PARAM) ?? TEAM_CHAT_CONVERSATION
  const view = readAgentWorkspaceView(searchParams)
  const isConversationView = view === "conversation"
  const isDocumentView = view === "document"
  const isReviewView = view === "review"
  const isKnowledgeView = view === "knowledge"
  const isTeamChat = conversationId === TEAM_CHAT_CONVERSATION
  const setView = useCallback((next: AgentWorkspaceView) => {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      if (next === "conversation") params.delete("view")
      else params.set("view", next)
      return params
    })
  }, [setSearchParams])
  const handleViewChange = useCallback((next: string) => {
    if (next === "conversation" || next === "document" || next === "review" || next === "knowledge") setView(next)
  }, [setView])
  // Selection-based requests belong to the main conversation, not the last task.
  useEffect(() => {
    if (!agent.pendingChip && !agent.pendingPrompt) return
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set(CONVERSATION_PARAM, TEAM_CHAT_CONVERSATION)
      params.delete("view")
      return params
    }, { replace: true })
  }, [agent.pendingChip, agent.pendingPrompt, setSearchParams])
  const panelRef = useRef<WorkingSetPanelHandle>(null)

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
  const showDocumentTab = isTeamChat || view === "document"
  const showReviewTab = view === "review" || (isTeamChat && hasReviewWork)
  const onVisibleCellIdsChange = workspace?.onVisibleCellIdsChange
  useEffect(() => {
    if (view !== "document") onVisibleCellIdsChange?.([])
    if (view === "review" && isTeamChat) panelRef.current?.focusFirstPending()
  }, [view, isTeamChat, onVisibleCellIdsChange])

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
  const ruleById = useMemo(() => new Map(agent.rules.map((r) => [r.id, r])), [agent.rules])
  const lintRow = useCallback(
    (row: WorkingSetRow, text: string): string[] => {
      if (!row.stagedEvent || enabledRules.length === 0) return []
      const cell = lintCellFor(row.stagedEvent, agent.resolveCell, text)
      return checkRulesForCell(cell, row.stagedEvent.fileId ?? row.fileId ?? "", enabledRules).map((inf) => {
        const rule = ruleById.get(inf.ruleId)
        const ruleName = rule ? translateRuleName(rule, t) : inf.ruleId
        return formatInfractionMessage(inf, ruleName, t)
      })
    },
    [enabledRules, ruleById, agent.resolveCell, t],
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
          onReview={() => setView("review")}
          onUndo={applying ? undefined : () => undoProposal(proposal)}
        />
      )
    },
    [decided, enabledRules, agent.resolveCell, applying, undoProposal, setView],
  )

  const renderChannel = (channel: TeamChannelProps) => (
    <AgentDockView
      {...agent}
      conversationPrelude={channel.items.length > 0 || channel.heldQuestions > 0
        ? <TeamChannel {...channel} conversationRuns={[]} embedded />
        : undefined}
      renderProposalOverride={renderProposalOverride}
      onReviewMemory={() => setView("knowledge")}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Own Tabs root for the view switch so the Text/Audio/Agent switch
          (also Tabs) is not nested. Same chrome as the editor chapter row. */}
      <div data-testid="agent-toolbar-row" className={cn(EDITOR_SURFACE_TOOLBAR_CLASS, "flex-wrap")}>
        {activeRun && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
            <Spinner className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {progress ? `${progress.label} — ${progress.done}/${progress.total}` : t("agentWorkspace.working")}
            </span>
          </span>
        )}
        {state.queued.length > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground">{t("agentWorkspace.queued", { count: state.queued.length })}</span>
        )}

        <Tabs value={view} onValueChange={handleViewChange} className="gap-0">
          <TabsList aria-label={t("agentWorkspace.sections")}>
            <TabsTrigger value="conversation">{t("agentWorkspace.conversation")}</TabsTrigger>
            {showDocumentTab && (
              <TabsTrigger value="document">{t("agentWorkspace.document")}</TabsTrigger>
            )}
            {showReviewTab && (
              <TabsTrigger value="review">{t("agent.team.reviewDrafts")}</TabsTrigger>
            )}
            <TabsTrigger value="knowledge">{t("agentWorkspace.projectKnowledge")}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="ms-auto flex shrink-0 items-center gap-2">
          {editorMode ? (
            <>
              <EditorModeToggle
                lens={editorMode.lens}
                onChange={editorMode.onLensChange}
                agentActive
                timeOrdered={editorMode.timeOrdered}
              />
              <OverflowMenu
                items={fileMenuItems ?? []}
                triggerVariant="outline"
                triggerSize="icon"
                triggerClassName={EDITOR_SURFACE_OVERFLOW_TRIGGER_CLASS}
                ariaLabel="File options"
                testId="file-options-menu"
              />
            </>
          ) : null}
          {credits && <CreditsDial {...credits} />}
          {state.isStreaming && (
            <Button type="button" variant="outline" size="sm" onClick={stop}>
              <Square data-icon="inline-start" />
              {t("common.stop")}
            </Button>
          )}
          <AgentChatOptions
            key={JSON.stringify([agent.projectId, agent.author])}
            onReset={reset}
            disabled={applying}
          />
          <Link to={editorHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <ArrowLeft aria-hidden data-icon="inline-start" className="rtl:rotate-180" />
            {t("agentWorkspace.backToEditor")}
          </Link>
          {onCollapse ? (
            <AppTooltip content={t("agentWorkspace.collapseHelp")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={onCollapse}
                aria-label={t("agentWorkspace.collapsePane")}
              >
                <Minimize2 />
              </Button>
            </AppTooltip>
          ) : null}
        </div>
      </div>

      <Tabs
        value={view}
        onValueChange={handleViewChange}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        {isConversationView && <TabsContent value="conversation" className="flex min-h-0 flex-1 flex-col">
          <TeamThreadsView
            projectId={agent.projectId}
            fileNames={fileNames}
            jwt={agent.jwt}
            author={agent.author}
            roleLevel={agent.roleLevel}
            renderChannel={renderChannel}
          />
        </TabsContent>}

        {isDocumentView && <TabsContent value="document" className="flex min-h-0 flex-1 flex-col">
          <AgentDocumentContext workspace={workspace ?? { cells: [], scopeAvailable: false }} onChooseFile={onChooseFile} />
        </TabsContent>}

        {isReviewView && <TabsContent value="review" className="flex min-h-0 flex-1 flex-col">
          {isTeamChat ? (
            <>
              <div className="shrink-0 border-b px-3 py-2">
                <Button variant="ghost" size="sm" onClick={() => setView("conversation")}>
                  <ArrowLeft aria-hidden data-icon="inline-start" />
                  {t("agentWorkspace.backToConversation")}
                </Button>
              </div>
              <WorkingSetPanel
                ref={panelRef}
                rows={stageRows}
                showSource
                title={t("agent.team.reviewDrafts")}
                language={workspace?.targetLanguage}
                busy={applying}
                lintRow={lintRow}
                onAccept={(row, value) => acceptRows([{ row, value }])}
                onAcceptAll={(valueFor) => acceptRows(pending.map((row) => ({ row, value: valueFor(row) })))}
                onReject={rejectRow}
                onJumpToCell={onJumpToCell}
              />
            </>
          ) : (
            <TeamThreadsView projectId={agent.projectId} fileNames={fileNames} jwt={agent.jwt} author={agent.author} roleLevel={agent.roleLevel} review />
          )}
        </TabsContent>}

        {isKnowledgeView && <TabsContent value="knowledge" className="min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex items-center justify-center gap-1.5 p-6 text-xs text-muted-foreground">
                <Spinner className="h-3.5 w-3.5" />
                {t("agentWorkspace.loadingMemory")}
              </div>
            }
          >
            <AgentMemoryTab projectId={agent.projectId} roleLevel={agent.roleLevel ?? null} />
          </Suspense>
        </TabsContent>}
      </Tabs>
    </div>
  )
}
