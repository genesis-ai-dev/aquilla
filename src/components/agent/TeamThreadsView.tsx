/**
 * TeamThreadsView.tsx — the workbench's Team tab.
 *
 * v2, the one-channel model (2026-08-28 social-workspace design): the team is
 * ONE project channel, not a thread list. The Coordinator speaks at top level
 * — a dispatch message per autopilot run, a question message per decision it
 * can't settle alone — and the live chat session continues underneath, in the
 * same shared session store the Chat tab drives. Every one of those messages
 * owns a thread; opening one gives the thread the width and collapses the
 * channel to a narrow spine of avatars in the same order, so the user keeps
 * their place in time. One composer sits at the bottom throughout: in the
 * channel it addresses the orchestrator, in a run thread it addresses that
 * subagent (steering), and in a question thread it stands down because the
 * DecisionCard carries its own Answer input.
 *
 * Read-only over the same transport the activity inspector uses, polled every
 * 4s while the document is visible.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { AGENT_PERSONA_IDS, AGENT_PERSONAS, personaForRegion } from "@/lib/agent/personas"
import { buildRunFeed } from "@/lib/agent/social-feed"
import { composeAgentSend } from "@/lib/agent/compose-send"
import { useAgentSession } from "@/lib/agent/session-store"
import type { ContextChip } from "@/lib/agent/context-chip"
import {
  buildTeamChannel,
  isSteerableStatus,
  personaForRun,
  type TeamDispatchItem,
} from "@/lib/agent/team-channel"
import { normalizePhase } from "@/lib/contextual/process-graph"
import {
  fetchContextualDecisions,
  fetchContextualRunActivity,
  fetchContextualRuns,
  type ContextualDecisionsPage,
  type ContextualRunActivity,
  type ContextualRunRecord,
} from "@/lib/contextual/transport"
import { humanPassageLabel } from "../../../shared/span-label"
import { PersonaAvatar } from "./PersonaAvatar"
import { TeamChannel } from "./TeamChannel"
import { TeamChannelComposer } from "./TeamChannelComposer"
import { TeamChannelSpine } from "./TeamChannelSpine"
import { TeamThreadDetail } from "./TeamThreadDetail"
import { isRunWorking } from "./team-run-status"

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

function TeamRoster({ activePersonas, t }: { activePersonas: ReadonlySet<string>; t: TFunction }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
      <span className="text-[11px] font-semibold text-foreground/90">
        {t("agent.team.rosterTitle")}
      </span>
      <ul className="flex items-center gap-1.5" data-testid="team-roster">
        {AGENT_PERSONA_IDS.map((id) => (
          <li key={id} className="flex items-center gap-1">
            <span role="img" aria-label={t(AGENT_PERSONAS[id].nameKey)}>
              <PersonaAvatar personaId={id} size="sm" />
            </span>
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

function TeamEmptyState({ t }: { t: TFunction }) {
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
                <PersonaAvatar personaId={id} />
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
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
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

  // Channel data: initial load and a visibility-aware poll. The disposal
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
  const openItem = useMemo(
    () => channelItems.find((item) => item.threadId === openThreadId) ?? null,
    [channelItems, openThreadId],
  )

  // A thread whose parent message left the channel (answered question, run
  // paged out) has nothing left to show — fall back to the full channel
  // rather than stranding the user on an empty pane.
  useEffect(() => {
    if (openThreadId !== null && channelItems.length > 0 && openItem === null) {
      setOpenThreadId(null)
    }
  }, [openThreadId, openItem, channelItems.length])

  const openRun = openItem?.kind === "dispatch" ? openItem.run : null

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
        // The channel already reported reachability; a transient activity
        // failure keeps the previous feed rather than blanking the thread.
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

  // Esc closes the thread — the keyboard twin of clicking the spine.
  useEffect(() => {
    if (openThreadId === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenThreadId(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [openThreadId])

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
  // A question thread hides the composer: DecisionCard owns its own Answer
  // input, and a second box would be two ways to say one thing.
  const showComposer = openItem?.kind !== "question"

  let body: ReactNode
  if (loadFailed && runs === null) {
    body = (
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
  } else if (loading) {
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-4" aria-label={t("agent.team.loading")}>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-56" />
      </div>
    )
  } else if (isEmpty) {
    body = <TeamEmptyState t={t} />
  } else if (openItem) {
    body = (
      <>
        <TeamChannelSpine
          items={channelItems}
          openThreadId={openItem.threadId}
          onRestore={() => setOpenThreadId(null)}
        />
        <TeamThreadDetail
          item={openItem}
          projectId={projectId}
          title={
            openItem.kind === "dispatch"
              ? runTitle(openItem.run)
              : t("agent.team.needsYou")
          }
          feed={feed}
          feedLoading={activityLoading}
          onClose={() => setOpenThreadId(null)}
          onDecisionResolved={() => {
            void fetchContextualDecisions(projectId).then(setDecisions).catch(() => {})
          }}
        />
      </>
    )
  } else {
    body = (
      <TeamChannel
        items={channelItems}
        titleFor={titleFor}
        onOpenThread={setOpenThreadId}
        heldQuestions={Math.max(0, openCount - openDecisions.length)}
        conversationRuns={state.runs}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TeamRoster activePersonas={activePersonas} t={t} />
      <div className="flex min-h-0 flex-1">{body}</div>
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
  )
}
