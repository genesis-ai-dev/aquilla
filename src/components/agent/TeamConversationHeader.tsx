import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { buttonVariants } from "@/components/ui/button"
import { agentConversationHref } from "@/lib/agent/workspace-location"
import { runThreadId } from "@/lib/agent/team-channel"
import { AGENT_PERSONA_IDS } from "@/lib/agent/personas"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { useT } from "@/lib/i18n/I18nProvider"
import { AgentCardTrigger } from "./AgentCard"
import { runStatusKey } from "./team-run-status"

export interface TeamConversationHeaderProps {
  title: string
  projectId: string
  activePersonas: ReadonlySet<string>
  run?: ContextualRunRecord | null
  /** Full project count, including questions outside the visible page. */
  openQuestionCount?: number
  /** Omitted when the questions conversation is already open. */
  questionsHref?: string
  /** Controls at the end of the header row (v3: the agent-mode dial and the
   *  next-passage affordance on a stopped run). */
  actions?: ReactNode
  /** Verifier findings on the run's pending drafts (useRunReview). */
  findings?: { flagged: number; needsHuman: number }
}

export function TeamConversationHeader({
  title,
  projectId,
  activePersonas,
  run,
  openQuestionCount = 0,
  questionsHref,
  actions,
  findings,
}: TeamConversationHeaderProps) {
  const t = useT()
  const pendingDrafts = run?.proposedDrafts ?? 0
  // Project-wide questions must not be presented as belonging to one run.
  const pendingQuestions = run ? 0 : openQuestionCount
  const attention = pendingDrafts > 0
    ? t("agent.team.draftsReady", { count: pendingDrafts })
    : pendingQuestions > 0
      ? t("agent.team.questionsWaiting", { count: pendingQuestions })
      : null
  const actionHref = run && pendingDrafts > 0
    ? agentConversationHref(projectId, runThreadId(run.runId), "review")
    : pendingQuestions > 0
      ? questionsHref
      : undefined

  return (
    <header
      className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 py-3"
      data-testid="team-conversation-header"
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h2 className="min-w-0 truncate text-base font-semibold" title={title}>{title}</h2>
          {run && (
            <span className="shrink-0 text-xs text-muted-foreground" title={t("agentWorkspace.agentState", { state: t(runStatusKey(run)) })}>
              {pendingDrafts > 0 ? t("agentWorkspace.needsReview") : t(runStatusKey(run))}
            </span>
          )}
        </div>
        <ul
          className="flex shrink-0 items-center gap-2"
          aria-label={t("agent.team.rosterTitle")}
          data-testid="team-roster"
        >
          {AGENT_PERSONA_IDS.map((id) => (
            <li key={id} className="flex items-center gap-1">
              <AgentCardTrigger personaId={id} projectId={projectId} size="md" />
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
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {attention && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p role="status" aria-atomic="true" className="text-sm font-medium tabular-nums">
            {attention}
            {run && findings && findings.flagged > 0 && (
              <span className="font-normal text-muted-foreground" data-testid="run-findings-summary">
                {" · "}{t("agent.pr.stats.flagged", { count: findings.flagged })}
                {findings.needsHuman > 0 && <>{" · "}<span className="font-medium text-foreground">{t("agent.pr.stats.needsYou", { count: findings.needsHuman })}</span></>}
              </span>
            )}
          </p>
          {actionHref && (
            <Link to={actionHref} replace={!run} className={buttonVariants({ size: "sm" })}>
              {run ? t("agentWorkspace.reviewPending", { count: pendingDrafts }) : t("agent.team.viewQuestions")}
            </Link>
          )}
        </div>
      )}
    </header>
  )
}
