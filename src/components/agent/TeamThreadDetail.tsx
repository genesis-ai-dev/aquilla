/**
 * TeamThreadDetail.tsx — one autopilot run's conversation in the Team tab
 * (v2.1 typical-chat layout): the subagent's play-by-play as a
 * persona-attributed, plain-language feed (social-feed.ts). The conversations
 * list stays visible beside it, so there is no back navigation here — just
 * the feed on a flat canvas. Identity lives in the avatars; names render
 * monochrome at medium weight.
 */

import { Link } from "react-router-dom"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { useI18n, useT, type TFunction } from "@/lib/i18n/I18nProvider"
import { draftReviewHref } from "@/components/project-workspace-lane-deeplink"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import type { TeamFeedMessage } from "@/lib/agent/social-feed"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { PersonaAvatar } from "./PersonaAvatar"

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
          <span className="text-xs font-medium text-foreground">{t(persona.nameKey)}</span>
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
  run: ContextualRunRecord
  projectId: string
  feed: TeamFeedMessage[]
  feedLoading: boolean
}

export function TeamThreadDetail({ run, projectId, feed, feedLoading }: TeamThreadDetailProps) {
  const t = useT()
  const reviewHref = draftReviewHref(projectId, run.fileId, null, run.targetLang ?? "")
  return (
    <ScrollArea className="min-h-0 flex-1" data-testid="team-thread-detail">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
        {feed.length === 0 ? (
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
            <FeedMessageRow key={message.id} message={message} reviewHref={reviewHref} />
          ))
        )}
      </div>
    </ScrollArea>
  )
}
