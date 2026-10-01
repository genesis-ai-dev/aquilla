/**
 * TeamThreadDetail.tsx — one autopilot run's conversation in the Team tab
 * (v2.2 three-column layout): the subagent's play-by-play as a
 * persona-attributed, plain-language feed (social-feed.ts). Each step's
 * explicit details control opens the optional inspector; message text stays
 * readable and selectable. Adjacent updates share a teammate byline; repeated
 * routine phases sit behind a disclosure without hiding notes or outcomes.
 */

import { useId, useState } from "react"
import { ChevronRight, Info } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Skeleton } from "@/components/ui/skeleton"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { agentConversationHref } from "@/lib/agent/workspace-location"
import { runThreadId } from "@/lib/agent/team-channel"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import { groupFeedByPassage, groupRunFeed, type TeamFeedMessage, type TeamFeedPassage } from "@/lib/agent/social-feed"
import type { RunReview } from "@/hooks/useRunReview"
import { feedMessageText } from "@/lib/agent/team-channel"
import type { ContextualRunRecord } from "@/lib/contextual/transport"
import { PersonaAvatar } from "./PersonaAvatar"

export function FeedMessageRow({
  message,
  reviewHref,
  inspected,
  inspectorId,
  onInspect,
}: {
  message: TeamFeedMessage
  reviewHref: string | null
  inspected?: boolean
  inspectorId?: string
  onInspect?: (trigger: HTMLButtonElement) => void
}) {
  const t = useT()
  const sentence = feedMessageText(message, t)
  const excerpt = message.body.kind === "sceneReady" ? message.body.excerpt : null
  const reviewLinkHref = message.body.kind === "draftsStaged" ? reviewHref : null
  return (
    <div
      className={cn(
        "group/step flex items-start gap-2 rounded-md px-1.5 py-1 transition-colors",
        onInspect && "hover:bg-accent/40",
        inspected && "bg-accent",
      )}
      data-feed-kind={message.body.kind}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 select-text">
        <p className={cn(
          "leading-relaxed",
          message.body.kind === "phase" ? "text-xs text-muted-foreground" : "text-sm",
        )}>
          {sentence}
        </p>
        {excerpt && (
          <blockquote className="mt-0.5 border-s-2 border-border ps-2 text-xs leading-relaxed text-muted-foreground">
            {excerpt}
          </blockquote>
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
      {onInspect && (
        <AppTooltip
          content={t(inspected ? "agent.team.step.hideDetails" : "agent.team.step.viewDetails")}
          disabled={inspected}
          delay={150}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              "shrink-0",
              !inspected && "[@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/step:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within/step:opacity-100",
            )}
            aria-label={t(
              inspected ? "agent.team.step.hideDetailsAriaLabel" : "agent.team.step.viewDetailsAriaLabel",
              { step: sentence },
            )}
            aria-expanded={Boolean(inspected)}
            aria-controls={inspected ? inspectorId : undefined}
            onClick={(event) => onInspect(event.currentTarget)}
          >
            <Info aria-hidden data-icon="inline-start" />
          </Button>
        </AppTooltip>
      )}
    </div>
  )
}

function RoutineUpdates({
  messages,
  reviewHref,
  inspectedId,
  inspectorId,
  onInspect,
}: {
  messages: TeamFeedMessage[]
  reviewHref: string | null
  inspectedId?: string | null
  inspectorId?: string
  onInspect?: (message: TeamFeedMessage, trigger: HTMLButtonElement) => void
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
      inspectorId={inspectorId}
      onInspect={onInspect ? (trigger) => onInspect(message, trigger) : undefined}
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

interface FeedWiring {
  reviewHref: string
  inspectedId?: string | null
  inspectorId?: string
  onInspect?: (message: TeamFeedMessage, trigger: HTMLButtonElement) => void
}

/** Persona-attributed groups for one passage (or the run-level messages). */
function FeedGroups({ messages, wiring }: { messages: TeamFeedMessage[]; wiring: FeedWiring }) {
  const { locale, t } = useI18n()
  const { reviewHref, inspectedId, inspectorId, onInspect } = wiring
  return (
    <>
      {groupRunFeed(messages).map((group) => (
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
                inspectorId={inspectorId}
                onInspect={onInspect}
              />
            ) : (
              <FeedMessageRow
                key={part.message.id}
                message={part.message}
                reviewHref={reviewHref}
                inspected={inspectedId === part.message.id}
                inspectorId={inspectorId}
                onInspect={onInspect ? (trigger) => onInspect(part.message, trigger) : undefined}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

/** The Reviewer's per-passage review entry, like a pull-request review. */
function PassageReview({ span, flagged, needsHuman, checksHref }: {
  span: string
  flagged: number
  needsHuman: number
  checksHref: string
}) {
  const t = useT()
  return (
    <div className="flex items-start gap-2.5" data-testid="passage-review" role="group" aria-label={t(AGENT_PERSONAS.reviewer.nameKey)}>
      <PersonaAvatar personaId="reviewer" className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md border border-border/60 px-2.5 py-1.5">
        <p className="text-sm">
          {t("agent.pr.review", { span, count: flagged })}
          {needsHuman > 0 && <> · <span className="font-medium">{t("agent.pr.reviewNeedsYou", { count: needsHuman })}</span></>}
        </p>
        <Link to={checksHref} className="w-fit text-xs font-medium underline underline-offset-2 hover:text-foreground">
          {t("agent.pr.viewChecks")}
        </Link>
      </div>
    </div>
  )
}

/** One passage: open when notable, otherwise folded to a one-line summary. */
function PassageSection({ section, wiring, findings, checksHref }: {
  section: TeamFeedPassage
  wiring: FeedWiring
  findings: { flagged: number; needsHuman: number } | undefined
  checksHref: string
}) {
  const t = useT()
  const contentId = useId()
  const [expanded, setExpanded] = useState<boolean | null>(null)
  // A folded passage still opens for the step the inspector is showing.
  const holdsInspected = section.messages.some((m) => m.id === wiring.inspectedId)
  const review = section.spanLabel && findings && findings.flagged > 0 ? (
    <PassageReview span={section.spanLabel} flagged={findings.flagged} needsHuman={findings.needsHuman} checksHref={checksHref} />
  ) : null
  if (section.notable) {
    return (
      <div className="flex flex-col gap-4" data-passage={section.spanLabel ?? "run"} data-notable="true">
        <FeedGroups messages={section.messages} wiring={wiring} />
        {review}
      </div>
    )
  }
  const open = expanded ?? holdsInspected
  return (
    <div data-passage={section.spanLabel ?? "run"} data-notable="false">
      <Collapsible open={open} onOpenChange={setExpanded} className="flex min-w-0 flex-col gap-2">
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
            <span className="truncate text-xs text-muted-foreground">
              {t("agent.pr.passageSummary", { span: section.spanLabel ?? "", count: section.drafts })}
            </span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div id={contentId} className="flex flex-col gap-4">
            <FeedGroups messages={section.messages} wiring={wiring} />
            {review}
          </div>
        </CollapsibleContent>
      </Collapsible>
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
  inspectorId?: string
  onInspect?: (message: TeamFeedMessage, trigger: HTMLButtonElement) => void
  /** Pending drafts and their findings (useRunReview): which passages stay
   *  open, and the Reviewer's per-passage review entries. */
  review?: RunReview
}

export function TeamThreadDetail({
  run,
  projectId,
  feed,
  feedLoading,
  inspectedId,
  inspectorId,
  onInspect,
  review,
}: TeamThreadDetailProps) {
  const t = useT()
  const reviewHref = agentConversationHref(projectId, runThreadId(run.runId), "review")
  const checksHref = agentConversationHref(projectId, runThreadId(run.runId), "checks")
  const sections = groupFeedByPassage(feed, review?.needsHumanSpans ?? new Set())
  const findingsBySpan = new Map<string, { flagged: number; needsHuman: number }>()
  for (const draft of review?.drafts ?? []) {
    if (!draft.spanLabel || !draft.review?.findings.length) continue
    const entry = findingsBySpan.get(draft.spanLabel) ?? { flagged: 0, needsHuman: 0 }
    entry.flagged += 1
    if (draft.review.triage === "human") entry.needsHuman += 1
    findingsBySpan.set(draft.spanLabel, entry)
  }
  const wiring: FeedWiring = { reviewHref, inspectedId, inspectorId, onInspect }
  return (
    // Stick-to-bottom feed — same contract as TeamChannel: follow while at the
    // bottom, break on upward scroll, ArrowDown re-engages.
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={64}>
      <MessageScroller className="min-h-0 flex-1" data-testid="team-thread-detail">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4">
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
          sections.map((section) => (
            <PassageSection
              key={section.id}
              section={section}
              wiring={wiring}
              findings={section.spanLabel ? findingsBySpan.get(section.spanLabel) : undefined}
              checksHref={checksHref}
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
