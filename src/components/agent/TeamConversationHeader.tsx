import { Link } from "react-router-dom"
import { buttonVariants } from "@/components/ui/button"
import { draftReviewHref } from "@/components/project-workspace-lane-deeplink"
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
}

export function TeamConversationHeader({
  title,
  projectId,
  activePersonas,
  run,
  openQuestionCount = 0,
  questionsHref,
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
    ? draftReviewHref(projectId, run.fileId, null, run.targetLang ?? "")
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
            <span className="shrink-0 text-xs text-muted-foreground">{t(runStatusKey(run))}</span>
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
      </div>
      {attention && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p role="status" aria-atomic="true" className="text-sm font-medium tabular-nums">
            {attention}
          </p>
          {actionHref && (
            <Link to={actionHref} replace={!run} className={buttonVariants({ size: "sm" })}>
              {t(run ? "agent.team.reviewDrafts" : "agent.team.viewQuestions")}
            </Link>
          )}
        </div>
      )}
    </header>
  )
}
