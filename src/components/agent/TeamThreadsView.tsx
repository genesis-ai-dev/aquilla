/**
 * TeamThreadsView.tsx — the workbench's Team tab.
 *
 * v2.1, the typical-chat layout (2026-08-28 notes): a conversations LIST
 * beside one ACTIVE conversation, progressive disclosure instead of panels.
 * The app's dock is the slim icon rail; inside the tab, the middle column
 * lists conversations (bold name, one-line preview, quiet time, one accent
 * badge for counts that need the human) and the right column hosts the
 * active conversation. "Team chat" — the orchestrator — is pinned first and
 * selected by default; every autopilot run is its own conversation; open
 * questions consolidate into a single "needs your expertise" conversation.
 * Focus mode hides the list, leaving the conversation centered on a wide
 * canvas. One composer sits at the bottom: in Team chat it addresses the
 * orchestrator, in a run conversation it addresses that subagent (steering,
 * with a scope chip), and in the questions conversation it stands down
 * because DecisionCard carries its own Answer input.
 *
 * Read-only over the same transport the activity inspector uses, polled every
 * 4s while the document is visible.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle, PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { AGENT_PERSONA_IDS, AGENT_PERSONAS, personaForRegion } from "@/lib/agent/personas"
import { buildRunFeed } from "@/lib/agent/social-feed"
import { composeAgentSend } from "@/lib/agent/compose-send"
import { useAgentSession } from "@/lib/agent/session-store"
import type { AgentRunUi } from "@/lib/agent/run-state"
import type { ContextChip } from "@/lib/agent/context-chip"
import {
  QUESTIONS_CONVERSATION,
  TEAM_CHAT_CONVERSATION,
  buildTeamChannel,
  isSteerableStatus,
  personaForRun,
  runThreadId,
  type TeamDispatchItem,
} from "@/lib/agent/team-channel"
import { normalizePhase } from "@/lib/contextual/process-graph"
import { DecisionCard } from "@/components/contextual/DecisionCard"
import {
  fetchContextualDecisions,
  fetchContextualRunActivity,
  fetchContextualRuns,
  type ContextualDecisionsPage,
  type ContextualRunActivity,
  type ContextualRunRecord,
} from "@/lib/contextual/transport"
import { humanPassageLabel } from "../../../shared/span-label"
import { AgentCardTrigger } from "./AgentCard"
import { TeamChannel } from "./TeamChannel"
import { TeamChannelComposer } from "./TeamChannelComposer"
import { TeamConversationList, type TeamConversationRow } from "./TeamConversationList"
import { TeamThreadDetail } from "./TeamThreadDetail"
import { isRunWorking, runStatusKey } from "./team-run-status"

const POLL_MS = 4_000
const RUN_PAGE_LIMIT = 12

export interface TeamThreadsViewProps {
  projectId: string
  /** File display names for message/thread titles; falls back to a generic label. */
  fileNames?: ReadonlyMap<string, string>
  /**
   * Session wiring for the channel composer. The workbench mounts this tab
   * with projectId + fileNames only, so both default to the signed-in
   * session — pass them explicitly to guarantee the Team tab and the Chat tab
   * address the same session-store instance (`author` is its owner key).
   */
  jwt?: string | null
  author?: string
}

/** The latest line of the shared chat session, for the Team chat list row. */
function teamChatPreview(runs: readonly AgentRunUi[], t: TFunction): string {
  const last = runs.at(-1)
  if (!last) return t("agent.team.teamChatPreviewEmpty")
  for (let i = last.items.length - 1; i >= 0; i--) {
    const item = last.items[i]
    if (item.kind === "text" && item.text.trim()) return item.text.trim()
  }
  return last.prompt
}

function TeamRoster({
  activePersonas,
  projectId,
  t,
}: {
  activePersonas: ReadonlySet<string>
  projectId: string
  t: TFunction
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <span className="text-[11px] font-medium text-foreground/90">
        {t("agent.team.rosterTitle")}
      </span>
      <ul className="flex items-center gap-1.5" data-testid="team-roster">
        {AGENT_PERSONA_IDS.map((id) => (
          <li key={id} className="flex items-center gap-1">
            <AgentCardTrigger personaId={id} projectId={projectId} size="sm" />
            {activePersonas.has(id) && (
              <span
                data-testid={`team-roster-live-${id}`}
                aria-label={t("autopilot.status.working")}
                className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none"
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function TeamEmptyState({ projectId, t }: { projectId: string; t: TFunction }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex max-w-sm flex-col gap-4">
        <div>
          <p className="text-sm font-medium">{t("agent.team.emptyTitle")}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("agent.team.emptyBody")}
          </p>
        </div>
        <ul className="flex flex-col gap-2.5">
          {AGENT_PERSONA_IDS.map((id) => {
            const persona = AGENT_PERSONAS[id]
            return (
              <li key={id} className="flex items-start gap-2.5">
                <AgentCardTrigger personaId={id} projectId={projectId} size="md" />
                <div className="min-w-0">
                  <p className="text-xs font-medium">{t(persona.nameKey)}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(persona.taglineKey)}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-muted-foreground">{t("agent.team.emptyHint")}</p>
      </div>
    </div>
  )
}

export function TeamThreadsView({ projectId, fileNames, jwt, author }: TeamThreadsViewProps) {
  const { t } = useI18n()
  const { session } = useFrontierSession()
  const sessionJwt = jwt !== undefined ? jwt : (session?.jwt ?? null)
  // Must match the owner key AgentDockView passes, or the Team tab would open
  // a SECOND session store and show a different conversation than the Chat tab.
  const ownerKey = author ?? session?.username ?? "local"
  const { state, send, stop } = useAgentSession(projectId, ownerKey)

  const [runs, setRuns] = useState<ContextualRunRecord[] | null>(null)
  const [decisions, setDecisions] = useState<ContextualDecisionsPage | null>(null)
  const [selectedId, setSelectedId] = useState<string>(TEAM_CHAT_CONVERSATION)
  const [focusMode, setFocusMode] = useState(false)
  const [activity, setActivity] = useState<ContextualRunActivity | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const refresh = useCallback(async () => {
    const [runsPage, decisionsPage] = await Promise.all([
      fetchContextualRuns(projectId, { limit: RUN_PAGE_LIMIT }),
      fetchContextualDecisions(projectId),
    ])
    return { runsPage, decisionsPage }
  }, [projectId])

  // Conversation data: initial load and a visibility-aware poll. The disposal
  // guard drops late responses after a project switch (repo read-hook idiom).
  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const { runsPage, decisionsPage } = await refresh()
        if (disposed) return
        setRuns(runsPage.runs)
        setDecisions(decisionsPage)
        setLoadFailed(false)
      } catch {
        if (!disposed) setLoadFailed(true)
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      void load()
    }, POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [refresh])

  const openDecisions = useMemo(() => decisions?.decisions ?? [], [decisions])
  const openCount = decisions?.openCount ?? 0
  const channelItems = useMemo(
    () => buildTeamChannel(runs ?? [], openDecisions),
    [runs, openDecisions],
  )

  const openRun = useMemo(
    () => (runs ?? []).find((run) => runThreadId(run.runId) === selectedId) ?? null,
    [runs, selectedId],
  )

  // A conversation that left the list (answered questions, run paged out)
  // has nothing to show — fall back to Team chat rather than a blank pane.
  useEffect(() => {
    if (selectedId === TEAM_CHAT_CONVERSATION) return
    if (selectedId === QUESTIONS_CONVERSATION && openCount > 0) return
    if (openRun !== null) return
    if (runs === null || decisions === null) return
    setSelectedId(TEAM_CHAT_CONVERSATION)
  }, [selectedId, openRun, openCount, runs, decisions])

  // The open run's activity, polled on the same cadence.
  useEffect(() => {
    if (!openRun) {
      setActivity(null)
      return
    }
    let disposed = false
    setActivityLoading(true)
    const load = async () => {
      try {
        const result = await fetchContextualRunActivity(projectId, openRun.runId)
        if (!disposed) setActivity(result)
      } catch {
        // The list already reported reachability; a transient activity
        // failure keeps the previous feed rather than blanking the pane.
      } finally {
        if (!disposed) setActivityLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      void load()
    }, POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [projectId, openRun])

  // Esc returns to Team chat — the keyboard way home.
  useEffect(() => {
    if (selectedId === TEAM_CHAT_CONVERSATION) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(TEAM_CHAT_CONVERSATION)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectedId])

  const feed = useMemo(() => (activity ? buildRunFeed(activity) : []), [activity])

  const activePersonas = useMemo(() => {
    const active = new Set<string>()
    for (const run of runs ?? []) {
      if (!isRunWorking(run)) continue
      const region = normalizePhase(run.phase)
      active.add(region ? personaForRegion(region) : "coordinator")
    }
    return active
  }, [runs])

  const runTitle = useCallback(
    (run: ContextualRunRecord) =>
      fileNames?.get(run.fileId) ?? run.spanLabel ?? t("agent.team.unnamedThread"),
    [fileNames, t],
  )
  const titleFor = useCallback(
    (item: TeamDispatchItem) => runTitle(item.run),
    [runTitle],
  )

  // The conversations list: Team chat pinned first, then questions while any
  // are open, then runs newest-first (typical chat-list ordering).
  const listRows = useMemo<TeamConversationRow[]>(() => {
    const rows: TeamConversationRow[] = [
      {
        id: TEAM_CHAT_CONVERSATION,
        title: t("agent.team.teamChat"),
        preview: teamChatPreview(state.runs, t),
        at: null,
        badge: 0,
        live: state.isStreaming,
      },
    ]
    if (openCount > 0) {
      rows.push({
        id: QUESTIONS_CONVERSATION,
        title: t("agent.team.needsYou"),
        preview: openDecisions[0]?.reason ?? "",
        at: null,
        badge: openCount,
        live: false,
      })
    }
    const byNewest = [...(runs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    for (const run of byNewest) {
      const drafts = run.proposedDrafts ?? 0
      const span = humanPassageLabel(run.spanLabel)
      const status = t(runStatusKey(run))
      rows.push({
        id: runThreadId(run.runId),
        title: runTitle(run),
        preview:
          drafts > 0
            ? t("agent.team.draftsReady", { count: drafts })
            : span
              ? `${status} — ${span}`
              : status,
        at: run.updatedAt,
        badge: drafts,
        live: isRunWorking(run),
      })
    }
    return rows
  }, [state.runs, state.isStreaming, openCount, openDecisions, runs, runTitle, t])

  const sendToChannel = useCallback(
    (text: string, chips: ContextChip[]) => {
      const options = composeAgentSend({ text, chips, jwt: sessionJwt, projectId })
      if (!options) return
      send(options)
    },
    [sessionJwt, projectId, send],
  )

  const composerThread = openRun
    ? {
        runId: openRun.runId,
        personaId: personaForRun(openRun),
        scopeLabel: humanPassageLabel(openRun.spanLabel) ?? runTitle(openRun),
        steerable: isSteerableStatus(openRun.status),
      }
    : null

  const loading = runs === null && !loadFailed
  const isEmpty = channelItems.length === 0 && state.runs.length === 0
  // The questions conversation hides the composer: DecisionCard owns its own
  // Answer input, and a second box would be two ways to say one thing.
  const showComposer = selectedId !== QUESTIONS_CONVERSATION

  if (loadFailed && runs === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
        <p className="text-xs text-muted-foreground">{t("agent.team.loadFailed")}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadFailed(false)
            setRuns(null)
            void refresh()
              .then(({ runsPage, decisionsPage }) => {
                setRuns(runsPage.runs)
                setDecisions(decisionsPage)
              })
              .catch(() => setLoadFailed(true))
          }}
        >
          {t("agent.team.retry")}
        </Button>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4" aria-label={t("agent.team.loading")}>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-56" />
      </div>
    )
  }

  if (isEmpty) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <TeamRoster activePersonas={activePersonas} projectId={projectId} t={t} />
        <TeamEmptyState projectId={projectId} t={t} />
        {showComposer && (
          <TeamChannelComposer
            thread={null}
            isConfigured={Boolean(sessionJwt)}
            isStreaming={state.isStreaming}
            onStop={stop}
            onSendToChannel={sendToChannel}
          />
        )}
      </div>
    )
  }

  const conversationTitle =
    selectedId === TEAM_CHAT_CONVERSATION
      ? t("agent.team.teamChat")
      : selectedId === QUESTIONS_CONVERSATION
        ? t("agent.team.needsYou")
        : openRun
          ? runTitle(openRun)
          : ""

  let conversation: ReactNode
  if (selectedId === QUESTIONS_CONVERSATION) {
    conversation = (
      <ScrollArea className="min-h-0 flex-1" data-testid="team-questions">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          {openDecisions.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              projectId={projectId}
              onResolved={() => {
                void fetchContextualDecisions(projectId).then(setDecisions).catch(() => {})
              }}
            />
          ))}
          {openCount > openDecisions.length && (
            <p className="text-xs text-muted-foreground">
              {t("autopilot.decisions.held", { count: openCount - openDecisions.length })}
            </p>
          )}
        </div>
      </ScrollArea>
    )
  } else if (openRun) {
    conversation = (
      <TeamThreadDetail
        run={openRun}
        projectId={projectId}
        feed={feed}
        feedLoading={activityLoading}
      />
    )
  } else {
    conversation = (
      <TeamChannel
        items={channelItems}
        titleFor={titleFor}
        onOpenThread={setSelectedId}
        onOpenQuestions={() => setSelectedId(QUESTIONS_CONVERSATION)}
        heldQuestions={Math.max(0, openCount - openDecisions.length)}
        conversationRuns={state.runs}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TeamRoster activePersonas={activePersonas} projectId={projectId} t={t} />
      <div className="flex min-h-0 flex-1">
        {!focusMode && (
          <TeamConversationList rows={listRows} selectedId={selectedId} onSelect={setSelectedId} />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Flat conversation header: focus toggle, name, quiet status. */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6 shrink-0 text-muted-foreground"
              data-testid="team-focus-toggle"
              onClick={() => setFocusMode((v) => !v)}
              aria-label={t(focusMode ? "agent.team.showList" : "agent.team.hideList")}
              aria-pressed={focusMode}
            >
              {focusMode ? (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftClose className="h-3.5 w-3.5" />
              )}
            </Button>
            <span className="min-w-0 truncate text-sm font-medium">{conversationTitle}</span>
            {openRun && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t(runStatusKey(openRun))}
              </span>
            )}
          </div>
          {conversation}
          {showComposer && (
            <TeamChannelComposer
              thread={composerThread}
              isConfigured={Boolean(sessionJwt)}
              isStreaming={state.isStreaming}
              onStop={stop}
              onSendToChannel={sendToChannel}
            />
          )}
        </div>
      </div>
    </div>
  )
}
