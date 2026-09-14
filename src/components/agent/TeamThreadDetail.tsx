/**
 * TeamThreadDetail.tsx — one autopilot run's conversation in the Team tab
 * (v2.2 three-column layout): the subagent's play-by-play as a
 * persona-attributed, plain-language feed (social-feed.ts). Clicking a step
 * opens it in the step inspector — the optional third column — so the thread
 * itself stays calm. Adjacent updates share a teammate byline; repeated
 * routine phases sit behind a disclosure without hiding notes or outcomes.
 */

import { useId, useState } from "react"
import { ChevronRight } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { draftReviewHref } from "@/components/project-workspace-lane-deeplink"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import { groupRunFeed, type TeamFeedMessage } from "@/lib/agent/social-feed"
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
  const t = useT()
  const excerpt = message.body.kind === "sceneReady" ? message.body.excerpt : null
  const reviewLinkHref = message.body.kind === "draftsStaged" ? reviewHref : null
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md px-1.5 py-1 transition-colors",
        onInspect && "cursor-pointer outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
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
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn(
          "leading-relaxed",
          message.body.kind === "phase" ? "text-xs text-muted-foreground" : "text-sm",
        )}>
          {feedMessageText(message, t)}
        </p>
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

function RoutineUpdates({
  messages,
  reviewHref,
  inspectedId,
  onInspect,
}: {
  messages: TeamFeedMessage[]
  reviewHref: string | null
  inspectedId?: string | null
  onInspect?: (message: TeamFeedMessage) => void
}) {
  const t = useT()
  const contentId = useId()
  const [expanded, setExpanded] = useState<boolean | null>(null)
  // Respect explicit toggles; otherwise keep an already-inspected step visible.
  const open = expanded ?? messages.some((message) => message.id === inspectedId)

  const rows = messages.map((message) => (
    <FeedMessageRow
      key={message.id}
      message={message}
      reviewHref={reviewHref}
      inspected={inspectedId === message.id}
      onInspect={onInspect ? () => onInspect(message) : undefined}
    />
  ))
  if (messages.length < 2) return <>{rows}</>

  return (
    <Collapsible open={open} onOpenChange={setExpanded} className="flex min-w-0 flex-col">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start px-1.5"
          aria-expanded={open}
          aria-controls={open ? contentId : undefined}
        >
          <ChevronRight aria-hidden data-icon="inline-start" className={cn(open && "rotate-90")} />
          <span className="text-xs text-muted-foreground">
            {t(open ? "agent.team.hideActivityUpdates" : "agent.team.showActivityUpdates", {
              count: messages.length,
            })}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div id={contentId} className="flex flex-col gap-0.5">{rows}</div>
      </CollapsibleContent>
    </Collapsible>
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
  const { locale, t } = useI18n()
  const reviewHref = draftReviewHref(projectId, run.fileId, null, run.targetLang ?? "")
  const groups = groupRunFeed(feed)
  return (
    <ScrollArea className="min-h-0 flex-1" data-testid="team-thread-detail">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
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
          groups.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-label={t(AGENT_PERSONAS[group.persona].nameKey)}
              className="flex items-start gap-2.5"
              data-persona-group={group.persona}
            >
              <PersonaAvatar personaId={group.persona} className="mt-0.5" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline gap-2 px-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {t(AGENT_PERSONAS[group.persona].nameKey)}
                  </span>
                  {group.at && (
                    <time dateTime={group.at} className="text-[10px] text-muted-foreground">
                      {new Date(group.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
                    </time>
                  )}
                </div>
                {group.parts.map((part) => part.kind === "activity" ? (
                  <RoutineUpdates
                    key={part.id}
                    messages={part.messages}
                    reviewHref={reviewHref}
                    inspectedId={inspectedId}
                    onInspect={onInspect}
                  />
                ) : (
                  <FeedMessageRow
                    key={part.message.id}
                    message={part.message}
                    reviewHref={reviewHref}
                    inspected={inspectedId === part.message.id}
                    onInspect={onInspect ? () => onInspect(part.message) : undefined}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </ScrollArea>
  )
}
