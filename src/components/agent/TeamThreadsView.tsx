/**
 * TeamThreadsView.tsx — the workbench's Team surface.
 *
 * v2.2, the three-column layout (2026-08-28): the conversations LIST lives in
 * the left dock's Agent tab (AgentDockPanel) — this surface is the ACTIVE
 * conversation plus, when a step is clicked, the optional step-inspector
 * third column. Selection is URL-driven (CONVERSATION_PARAM) so the dock and
 * this pane share one source of truth: absent = Team chat (the orchestrator),
 * `run:<id>` = that autopilot run's conversation, `questions` = the one
 * consolidated "needs your expertise" conversation.
 *
 * One composer sits at the bottom: in Team chat it addresses the
 * orchestrator; in a run conversation it addresses that subagent (steering,
 * scope chip) — and on a FINISHED run it re-opens the work by starting a
 * fresh run seeded with the message (CONTRIBUTOR+); in the questions
 * conversation it stands down because DecisionCard has its own Answer input.
 *
 * Data comes from the shared team-conversations poller (4s, visibility-
 * aware); only the open run's activity is fetched here.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { ROLE } from "@/lib/frontier/roles"
import { AGENT_PERSONA_IDS, AGENT_PERSONAS, personaForRegion } from "@/lib/agent/personas"
import { buildRunFeed, type TeamFeedMessage } from "@/lib/agent/social-feed"
import { composeAgentSend } from "@/lib/agent/compose-send"
import { useAgentSession } from "@/lib/agent/session-store"
import type { ContextChip } from "@/lib/agent/context-chip"
import {
  CONVERSATION_PARAM,
  QUESTIONS_CONVERSATION,
  TEAM_CHAT_CONVERSATION,
  buildTeamChannel,
  feedMessageText,
  isSteerableStatus,
  personaForRun,
  runThreadId,
  type TeamDispatchItem,
} from "@/lib/agent/team-channel"
import { useTeamConversations } from "@/lib/agent/team-conversations"
import { normalizePhase } from "@/lib/contextual/process-graph"
import { DecisionCard } from "@/components/contextual/DecisionCard"
import {
  fetchContextualRunActivity,
  startFileContextualRun,
  type ContextualRunActivity,
  type ContextualRunRecord,
} from "@/lib/contextual/transport"
import { isFlagEnabled } from "@/lib/features/flags"
import { getProject } from "@/lib/store/project-index"
import { humanPassageLabel } from "../../../shared/span-label"
import { AgentCardTrigger } from "./AgentCard"
import { AgentModeControl } from "./AgentModeControl"
import { TeamChannel } from "./TeamChannel"
import { TeamChannelComposer } from "./TeamChannelComposer"
import { TeamStepInspector } from "./TeamStepInspector"
import { TeamThreadDetail } from "./TeamThreadDetail"
import { isRunWorking, runStatusKey } from "./team-run-status"

const POLL_MS = 4_000

export interface TeamThreadsViewProps {
  projectId: string
  /** File display names for message/thread titles; falls back to a generic label. */
  fileNames?: ReadonlyMap<string, string>
  /**
   * Session wiring for the channel composer. The workbench passes these so
   * the Team surface and the Chat tab address the same session-store
   * instance (`author` is its owner key); both default to the signed-in
   * session.
   */
  jwt?: string | null
  author?: string
  /** Project role level — gates re-opening finished runs by messaging. */
  roleLevel?: number | null
}

function TeamRoster({
  activePersonas,
  projectId,
  trailing,
  t,
}: {
  activePersonas: ReadonlySet<string>
  projectId: string
  /** The agent-mode dial, when the experiment is on. Sits opposite the roster:
   *  who is on the team, and how much they are allowed to do unprompted. */
  trailing?: ReactNode
  t: TFunction
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <span className="text-[11px] font-medium text-foreground/90">
        {t("agent.team.rosterTitle")}
      </span>
      {trailing && <span className="order-last ms-auto">{trailing}</span>}
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

export function TeamThreadsView({
  projectId,
  fileNames,
  jwt,
  author,
  roleLevel,
}: TeamThreadsViewProps) {
  const { t } = useI18n()
  const { session } = useFrontierSession()
  const sessionJwt = jwt !== undefined ? jwt : (session?.jwt ?? null)
  // Must match the owner key AgentDockView passes, or the Team surface would
  // open a SECOND session store and show a different conversation than Chat.
  const ownerKey = author ?? session?.username ?? "local"
  const { state, send, stop } = useAgentSession(projectId, ownerKey)
  const { runs, decisions, loadFailed, retry } = useTeamConversations(projectId)

  // Selection rides the URL so the dock list and this pane always agree.
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = searchParams.get(CONVERSATION_PARAM) ?? TEAM_CHAT_CONVERSATION
  const setSelected = useCallback(
    (id: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (id === TEAM_CHAT_CONVERSATION) next.delete(CONVERSATION_PARAM)
          else next.set(CONVERSATION_PARAM, id)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // The agentModes experiment is DEVICE-LOCAL (it lives on the IDB project
  // record, never in shared settings), so it is read straight from IDB rather
  // than threaded down from ProjectWorkspace — mirrors ExperimentalFlagsSection.
  const [agentModesEnabled, setAgentModesEnabled] = useState(false)
  useEffect(() => {
    let disposed = false
    void getProject(projectId).then((local) => {
      if (disposed) return
      setAgentModesEnabled(isFlagEnabled(local ?? {}, "agentModes"))
    })
    return () => {
      disposed = true
    }
  }, [projectId])

  const [activity, setActivity] = useState<ContextualRunActivity | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  // "Next passage": one span, then a park. Per-conversation, so switching
  // conversations never shows a stale failure from another run.
  const [nextPassageBusy, setNextPassageBusy] = useState(false)
  const [nextPassageFailed, setNextPassageFailed] = useState(false)
  // Step inspector (the optional third column) — per selected conversation.
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  useEffect(() => {
    setInspectedId(null)
    setNextPassageFailed(false)
  }, [selectedId])

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
    setSelected(TEAM_CHAT_CONVERSATION)
  }, [selectedId, openRun, openCount, runs, decisions, setSelected])

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
        // The dock list already reported reachability; a transient activity
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
      if (event.key === "Escape") setSelected(TEAM_CHAT_CONVERSATION)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectedId, setSelected])

  const feed = useMemo(() => (activity ? buildRunFeed(activity) : []), [activity])
  const inspectedMessage = useMemo<TeamFeedMessage | null>(
    () => (inspectedId ? feed.find((message) => message.id === inspectedId) ?? null : null),
    [feed, inspectedId],
  )

  const activePersonas = useMemo(() => {
    const active = new Set<string>()
    for (const run of runs ?? []) {
      if (!isRunWorking(run)) continue
      const region = normalizePhase(run.phase)
      active.add(region ? personaForRegion(region) : "coordinator")
    }
    return active
  }, [runs])

  // `spanLabel` can be an opaque cell/span id when the server had no human ref
  // to name the wave by — humanPassageLabel rejects those, so a conversation
  // title is never a raw UUID (the "no raw ids anywhere user-facing" fix).
  const runTitle = useCallback(
    (run: ContextualRunRecord) =>
      fileNames?.get(run.fileId)
      ?? humanPassageLabel(run.spanLabel)
      ?? t("agent.team.unnamedThread"),
    [fileNames, t],
  )
  const titleFor = useCallback(
    (item: TeamDispatchItem) => runTitle(item.run),
    [runTitle],
  )

  // Bumped on every own channel send (composer or suggestion tap) — TeamChannel
  // snaps its feed back to the end so the sent message is in view.
  const [sendSignal, setSendSignal] = useState(0)
  const sendToChannel = useCallback(
    (text: string, chips: ContextChip[]) => {
      const options = composeAgentSend({ text, chips, jwt: sessionJwt, projectId })
      if (!options) return
      send(options)
      setSendSignal((s) => s + 1)
    },
    [sessionJwt, projectId, send],
  )

  const canStartRuns = (roleLevel ?? 0) >= ROLE.CONTRIBUTOR

  // A run that has stopped — finished, failed, stopped, or parked between
  // waves — is exactly where "just do the next bit, then I'll look" belongs.
  // A run still working already has momentum; another button would only race it.
  const canAskNextPassage =
    agentModesEnabled
    && canStartRuns
    && openRun !== null
    && (openRun.status === "done"
      || openRun.status === "failed"
      || openRun.status === "terminated"
      || openRun.status === "parked")

  const startNextPassage = useCallback(() => {
    if (!openRun) return
    setNextPassageBusy(true)
    setNextPassageFailed(false)
    // spanLimit 1 is the whole point: the server parks after one span so the
    // human reviews before more work — and more credit — is spent.
    void startFileContextualRun(projectId, openRun.fileId, openRun.targetLang ?? "", 1)
      .then(({ runId }) => {
        retry()
        setSelected(runThreadId(runId))
      })
      .catch(() => setNextPassageFailed(true))
      .finally(() => setNextPassageBusy(false))
  }, [openRun, projectId, retry, setSelected])

  const composerThread = openRun
    ? {
        runId: openRun.runId,
        personaId: personaForRun(openRun),
        scopeLabel: humanPassageLabel(openRun.spanLabel) ?? runTitle(openRun),
        steerable: isSteerableStatus(openRun.status),
        reopen:
          !isSteerableStatus(openRun.status) && canStartRuns
            ? {
                projectId,
                fileId: openRun.fileId,
                targetLang: openRun.targetLang ?? "",
                onReopened: (runId: string) => {
                  retry()
                  setSelected(runThreadId(runId))
                },
              }
            : undefined,
      }
    : null

  const modeControl = agentModesEnabled ? (
    <AgentModeControl projectId={projectId} jwt={sessionJwt} roleLevel={roleLevel} />
  ) : null

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
        <Button type="button" variant="outline" size="sm" onClick={retry}>
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
        <TeamRoster
          activePersonas={activePersonas}
          projectId={projectId}
          trailing={modeControl}
          t={t}
        />
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
              onResolved={retry}
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
        inspectedId={inspectedId}
        onInspect={(message) =>
          setInspectedId((current) => (current === message.id ? null : message.id))
        }
      />
    )
  } else {
    conversation = (
      <TeamChannel
        items={channelItems}
        titleFor={titleFor}
        onOpenThread={setSelected}
        onOpenQuestions={() => setSelected(QUESTIONS_CONVERSATION)}
        heldQuestions={Math.max(0, openCount - openDecisions.length)}
        conversationRuns={state.runs}
        onSuggestionSend={(text) => sendToChannel(text, [])}
        sendSignal={sendSignal}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TeamRoster
          activePersonas={activePersonas}
          projectId={projectId}
          trailing={modeControl}
          t={t}
        />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Flat conversation header: name + quiet status +, on a stopped
              run, the one-more-passage affordance. */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
            <span className="min-w-0 truncate text-sm font-medium">{conversationTitle}</span>
            {openRun && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t(runStatusKey(openRun))}
              </span>
            )}
            {canAskNextPassage && (
              <span className="ms-auto flex shrink-0 items-center gap-1.5">
                {nextPassageFailed && (
                  <span role="alert" className="text-[11px] text-destructive">
                    {t("agent.team.nextPassageFailed")}
                  </span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  data-testid="team-next-passage"
                  disabled={nextPassageBusy}
                  onClick={startNextPassage}
                >
                  {nextPassageBusy
                    ? t("agent.team.nextPassageStarting")
                    : t("agent.team.nextPassage")}
                </Button>
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
        {inspectedMessage && (
          <TeamStepInspector
            message={inspectedMessage}
            sentence={feedMessageText(inspectedMessage, t)}
            onClose={() => setInspectedId(null)}
          />
        )}
      </div>
    </div>
  )
}
