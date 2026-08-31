/**
 * TeamThreadDetail.tsx — one autopilot run's conversation in the Team tab
 * (v2.2 three-column layout): the subagent's play-by-play as a
 * persona-attributed, plain-language feed (social-feed.ts). Clicking a step
 * opens it in the step inspector — the optional third column — so the thread
 * itself stays calm. Identity lives in the avatars; names render monochrome
 * at medium weight.
 */

import { Link } from "react-router-dom"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { draftReviewHref } from "@/components/project-workspace-lane-deeplink"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import type { TeamFeedMessage } from "@/lib/agent/social-feed"
import { feedMessageText } from "@/lib/agent/team-channel"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { PersonaAvatar } from "./PersonaAvatar"

export function FeedMessageRow({
  message,
  reviewHref,
  inspected,
  onInspect,
}: {
  message: TeamFeedMessage
  reviewHref: string | null
  inspected?: boolean
  onInspect?: () => void
}) {
  const { locale, t } = useI18n()
  const persona = AGENT_PERSONAS[message.persona]
  const time = message.at
    ? new Date(message.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : null
  const excerpt = message.body.kind === "sceneReady" ? message.body.excerpt : null
  const reviewLinkHref = message.body.kind === "draftsStaged" ? reviewHref : null
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md px-1.5 py-1 transition-colors",
        onInspect && "cursor-pointer hover:bg-accent/40",
        inspected && "bg-accent",
      )}
      data-feed-kind={message.body.kind}
      role={onInspect ? "button" : undefined}
      tabIndex={onInspect ? 0 : undefined}
      aria-pressed={onInspect ? inspected : undefined}
      onClick={onInspect}
      onKeyDown={
        onInspect
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onInspect()
              }
            }
          : undefined
      }
    >
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
        {reviewLinkHref && (
          <Link
            to={reviewLinkHref}
            onClick={(event) => event.stopPropagation()}
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
  /** Step-inspector wiring (the optional third column). */
  inspectedId?: string | null
  onInspect?: (message: TeamFeedMessage) => void
}

export function TeamThreadDetail({
  run,
  projectId,
  feed,
  feedLoading,
  inspectedId,
  onInspect,
}: TeamThreadDetailProps) {
  const t = useT()
  const reviewHref = draftReviewHref(projectId, run.fileId, null, run.targetLang ?? "")
  return (
    // Stick-to-bottom feed — same contract as TeamChannel: follow while at the
    // bottom, break on upward scroll, ArrowDown re-engages.
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={64}>
      <MessageScroller className="min-h-0 flex-1" data-testid="team-thread-detail">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto flex w-full max-w-2xl flex-col gap-2 p-4">
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
            <FeedMessageRow
              key={message.id}
              message={message}
              reviewHref={reviewHref}
              inspected={inspectedId === message.id}
              onInspect={onInspect ? () => onInspect(message) : undefined}
            />
          ))
        )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="shadow-sm" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
