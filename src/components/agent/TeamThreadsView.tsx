/**
 * TeamThreadsView.tsx — the workbench's Team tab (2026-08-28 social-workspace
 * design): the autopilot pipeline presented as a small named team posting in
 * threads, Telegram-style, instead of a technical console.
 *
 * Left rail: the persona roster (live dot on whoever is working) above one
 * thread per autopilot run, plus a pinned "Needs your expertise" thread while
 * open decisions exist. Right pane: the selected thread as a message feed —
 * every message attributed to a persona (personas.ts) and phrased in plain
 * language (social-feed.ts). Read-only over the same transport the activity
 * inspector uses; decisions keep their existing answer/dismiss actions.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { AlertTriangle, MessageCircleQuestion } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useI18n, type TFunction } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { draftReviewHref } from "@/components/project-workspace-lane-deeplink"
import { DecisionCard } from "@/components/contextual/DecisionCard"
import { AGENT_PERSONA_IDS, AGENT_PERSONAS, personaForRegion } from "@/lib/agent/personas"
import { buildRunFeed, type TeamFeedMessage } from "@/lib/agent/social-feed"
import { normalizePhase } from "@/lib/contextual/process-graph"
import {
  fetchContextualDecisions,
  fetchContextualRunActivity,
  fetchContextualRuns,
  type ContextualDecisionsPage,
  type ContextualRunActivity,
  type ContextualRunRecord,
} from "@/lib/contextual/transport"
import { PersonaAvatar } from "./PersonaAvatar"

const POLL_MS = 4_000
const RUN_PAGE_LIMIT = 12
const DECISIONS_THREAD = "decisions"

export interface TeamThreadsViewProps {
  projectId: string
  /** File display names for thread titles; falls back to a generic label. */
  fileNames?: ReadonlyMap<string, string>
}

function statusKey(run: ContextualRunRecord): Parameters<TFunction>[0] {
  if (run.status === "failed") return "autopilot.status.needsAttention"
  if (run.status === "running" || run.status === "pausing") return "autopilot.status.working"
  if (run.status === "paused") return "autopilot.status.paused"
  if (run.status === "parked") {
    return run.total > run.done + run.failed ? "autopilot.status.queued" : "autopilot.status.idle"
  }
  if (run.status === "done") return "autopilot.status.complete"
  if (run.status === "terminated") return "autopilot.status.stopped"
  return "autopilot.status.notStarted"
}

function isWorking(run: ContextualRunRecord): boolean {
  return run.status === "running" || run.status === "pausing"
}

function feedMessageText(message: TeamFeedMessage, t: TFunction): string {
  const span = (label: string | null) => label ?? t("agent.team.spanFallback")
  const { body } = message
  switch (body.kind) {
    case "started":
      return t("agent.team.msg.started", { span: span(body.spanLabel) })
    case "phase":
      if (body.region === "reading") return t("agent.team.msg.reading", { span: span(body.spanLabel) })
      if (body.region === "drafting") return t("agent.team.msg.drafting", { span: span(body.spanLabel) })
      if (body.region === "checking") return t("agent.team.msg.checking", { span: span(body.spanLabel) })
      // buildRunFeed never emits staging phases; keep the mapping total anyway.
      return t("agent.team.msg.outcomeDone", { span: span(body.spanLabel) })
    case "sceneReady":
      return body.ambiguityCount != null && body.ambiguityCount > 0
        ? t("agent.team.msg.sceneReady", {
            span: span(body.spanLabel),
            count: body.ambiguityCount,
          })
        : t("agent.team.msg.sceneReadyUncounted", { span: span(body.spanLabel) })
    case "draftsStaged":
      return body.count != null
        ? t("agent.team.msg.draftsStaged", { count: body.count })
        : t("agent.team.msg.draftsStagedUncounted")
    case "outcome":
      if (body.status === "done") return t("agent.team.msg.outcomeDone", { span: span(body.spanLabel) })
      if (body.status === "partial") return t("agent.team.msg.outcomePartial", { span: span(body.spanLabel) })
      return t("agent.team.msg.outcomeFailed", { span: span(body.spanLabel) })
  }
}

function FeedMessageRow({
  message,
  reviewHref,
  locale,
  t,
}: {
  message: TeamFeedMessage
  reviewHref: string | null
  locale: string
  t: TFunction
}) {
  const persona = AGENT_PERSONAS[message.persona]
  const time = message.at
    ? new Date(message.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : null
  const excerpt = message.body.kind === "sceneReady" ? message.body.excerpt : null
  const reasons = message.body.kind === "outcome" ? message.body.reasons : []
  const reviewLinkHref = message.body.kind === "draftsStaged" ? reviewHref : null
  return (
    <div className="flex items-start gap-2" data-feed-kind={message.body.kind}>
      <PersonaAvatar personaId={persona.id} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-xs font-medium", persona.textClass)}>{t(persona.nameKey)}</span>
          {time && <span className="text-[10px] text-muted-foreground">{time}</span>}
        </div>
        <p className="text-sm leading-relaxed">{feedMessageText(message, t)}</p>
        {excerpt && (
          <blockquote className="mt-0.5 border-s-2 border-border ps-2 text-xs leading-relaxed text-muted-foreground">
            {excerpt}
          </blockquote>
        )}
        {reasons.length > 0 && (
          <ul className="mt-0.5 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        {reviewLinkHref && (
          <Link
            to={reviewLinkHref}
            className="mt-0.5 w-fit text-xs font-medium underline underline-offset-2 hover:text-foreground"
          >
            {t("agent.team.reviewDrafts")}
          </Link>
        )}
      </div>
    </div>
  )
}

function TeamRoster({ activeRegions, t }: { activeRegions: ReadonlySet<string>; t: TFunction }) {
  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2.5">
      <p className="text-[11px] font-semibold text-foreground/90">{t("agent.team.rosterTitle")}</p>
      <ul className="flex flex-col gap-1">
        {AGENT_PERSONA_IDS.map((id) => {
          const persona = AGENT_PERSONAS[id]
          const live = activeRegions.has(id)
          return (
            <li key={id} className="flex items-center gap-2">
              <PersonaAvatar personaId={id} size="sm" />
              <span className="text-xs">{t(persona.nameKey)}</span>
              {live && (
                <span
                  aria-label={t("autopilot.status.working")}
                  className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none"
                />
              )}
            </li>
          )
        })}
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

export function TeamThreadsView({ projectId, fileNames }: TeamThreadsViewProps) {
  const { locale, t } = useI18n()
  const [runs, setRuns] = useState<ContextualRunRecord[] | null>(null)
  const [decisions, setDecisions] = useState<ContextualDecisionsPage | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
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

  // List + decisions: initial load and a visibility-aware poll. The generation
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

  // First load picks a sensible thread: open questions first, else the
  // newest run. Never steals an explicit selection afterwards.
  useEffect(() => {
    if (selected !== null || runs === null || decisions === null) return
    if (decisions.openCount > 0) setSelected(DECISIONS_THREAD)
    else if (runs.length > 0) setSelected(runs[0].runId)
  }, [selected, runs, decisions])

  // The selected run's activity, polled on the same cadence while working.
  const selectedRun = useMemo(
    () => (runs ?? []).find((run) => run.runId === selected) ?? null,
    [runs, selected],
  )
  useEffect(() => {
    if (!selectedRun) {
      setActivity(null)
      return
    }
    let disposed = false
    setActivityLoading(true)
    const load = async () => {
      try {
        const result = await fetchContextualRunActivity(projectId, selectedRun.runId)
        if (!disposed) setActivity(result)
      } catch {
        // The runs list already reported reachability; a transient activity
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
  }, [projectId, selectedRun])

  const feed = useMemo(() => (activity ? buildRunFeed(activity) : []), [activity])

  const activePersonas = useMemo(() => {
    const active = new Set<string>()
    for (const run of runs ?? []) {
      if (!isWorking(run)) continue
      const region = normalizePhase(run.phase)
      active.add(region ? personaForRegion(region) : "coordinator")
    }
    return active
  }, [runs])

  const threadTitle = useCallback(
    (run: ContextualRunRecord) =>
      fileNames?.get(run.fileId) ?? run.spanLabel ?? t("agent.team.unnamedThread"),
    [fileNames, t],
  )

  const openDecisions = decisions?.decisions ?? []
  const openCount = decisions?.openCount ?? 0
  const loading = runs === null && !loadFailed

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

  if ((runs?.length ?? 0) === 0 && openCount === 0) {
    return <TeamEmptyState t={t} />
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* Thread rail — roster, then one row per conversation. */}
      <div className="flex w-60 shrink-0 flex-col border-e">
        <TeamRoster activeRegions={activePersonas} t={t} />
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col divide-y">
            {openCount > 0 && (
              <button
                type="button"
                onClick={() => setSelected(DECISIONS_THREAD)}
                aria-current={selected === DECISIONS_THREAD}
                className={cn(
                  "flex items-center gap-2 px-3 py-2.5 text-start transition-colors hover:bg-accent/60 active:scale-[0.99]",
                  selected === DECISIONS_THREAD && "bg-accent",
                )}
              >
                <MessageCircleQuestion className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {t("agent.team.needsYou")}
                </span>
                <Badge className="h-4 min-w-4 px-1 text-[10px]">{openCount}</Badge>
              </button>
            )}
            {(runs ?? []).map((run) => (
              <button
                key={run.runId}
                type="button"
                onClick={() => setSelected(run.runId)}
                aria-current={selected === run.runId}
                className={cn(
                  "flex flex-col gap-0.5 px-3 py-2.5 text-start transition-colors hover:bg-accent/60 active:scale-[0.99]",
                  selected === run.runId && "bg-accent",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {threadTitle(run)}
                  </span>
                  {(run.proposedDrafts ?? 0) > 0 && (
                    <Badge className="h-4 min-w-4 px-1 text-[10px]">{run.proposedDrafts}</Badge>
                  )}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {isWorking(run) && <Spinner className="h-2.5 w-2.5 shrink-0" />}
                  <span className="truncate">{t(statusKey(run))}</span>
                  <span className="ms-auto shrink-0">
                    {fmtShortCalendarDate(run.updatedAt, Date.now(), locale)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Selected thread. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected === DECISIONS_THREAD ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex max-w-xl flex-col gap-3 p-4">
              <p className="text-xs font-semibold text-foreground/90">
                {t("autopilot.decisions.heading")}
              </p>
              {openDecisions.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("autopilot.decisions.empty")}</p>
              ) : (
                openDecisions.map((decision) => (
                  <DecisionCard
                    key={decision.id}
                    decision={decision}
                    projectId={projectId}
                    onResolved={() => {
                      void fetchContextualDecisions(projectId).then(setDecisions).catch(() => {})
                    }}
                  />
                ))
              )}
              {openCount > openDecisions.length && (
                <p className="text-xs text-muted-foreground">
                  {t("autopilot.decisions.held", { count: openCount - openDecisions.length })}
                </p>
              )}
            </div>
          </ScrollArea>
        ) : selectedRun ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
              <span className="min-w-0 truncate text-sm font-medium">{threadTitle(selectedRun)}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t(statusKey(selectedRun))}
              </span>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex max-w-xl flex-col gap-3 p-4">
                {feed.length === 0 ? (
                  activityLoading ? (
                    <div className="flex flex-col gap-2">
                      <Skeleton className="h-4 w-56" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("agent.team.threadEmpty")}</p>
                  )
                ) : (
                  feed.map((message) => (
                    <FeedMessageRow
                      key={message.id}
                      message={message}
                      reviewHref={draftReviewHref(
                        projectId,
                        selectedRun.fileId,
                        null,
                        selectedRun.targetLang ?? "",
                      )}
                      locale={locale}
                      t={t}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </>
        ) : null}
      </div>
    </div>
  )
}
