/**
 * TeamThreadDetail.tsx — the thread pane of the one-channel Team tab
 * (v2 of the 2026-08-28 social-workspace design).
 *
 * A channel message owns a thread; this is what that thread contains. For an
 * autopilot dispatch it is the subagent's play-by-play — the same
 * persona-attributed, plain-language feed v1 showed in its right pane
 * (social-feed.ts). For a question it is the existing DecisionCard, which
 * carries its own Answer input, so the thread composer stays hidden there.
 */

import { ChevronLeft } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useI18n, useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { draftReviewHref } from "@/components/project-workspace-lane-deeplink"
import { DecisionCard } from "@/components/contextual/DecisionCard"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import type { TeamFeedMessage } from "@/lib/agent/social-feed"
import type { TeamChannelItem } from "@/lib/agent/team-channel"
import { PersonaAvatar } from "./PersonaAvatar"
import { runStatusKey } from "./team-run-status"

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

export function FeedMessageRow({
  message,
  reviewHref,
}: {
  message: TeamFeedMessage
  reviewHref: string | null
}) {
  const { locale, t } = useI18n()
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

export interface TeamThreadDetailProps {
  item: TeamChannelItem
  projectId: string
  /** Thread header title — the file name for a dispatch. */
  title: string
  /** Dispatch threads: the run's persona-attributed feed. */
  feed: TeamFeedMessage[]
  feedLoading: boolean
  /** Collapse the thread and restore the full-width channel. */
  onClose: () => void
  /** Question threads: refresh the decisions page after an answer/dismiss. */
  onDecisionResolved: () => void
}

export function TeamThreadDetail({
  item,
  projectId,
  title,
  feed,
  feedLoading,
  onClose,
  onDecisionResolved,
}: TeamThreadDetailProps) {
  const t = useT()
  const dispatchRun = item.kind === "dispatch" ? item.run : null
  const question = item.kind === "question" ? item.decision : null
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="team-thread-detail">
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          onClick={onClose}
          aria-label={t("agent.team.closeThread")}
        >
          <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
        </Button>
        <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        {dispatchRun && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {t(runStatusKey(dispatchRun))}
          </span>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-xl flex-col gap-3 p-4">
          {question ? (
            <DecisionCard
              decision={question}
              projectId={projectId}
              onResolved={onDecisionResolved}
            />
          ) : feed.length === 0 ? (
            feedLoading ? (
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
                reviewHref={
                  dispatchRun
                    ? draftReviewHref(projectId, dispatchRun.fileId, null, dispatchRun.targetLang ?? "")
                    : null
                }
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
