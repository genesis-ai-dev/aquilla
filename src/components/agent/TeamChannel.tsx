/**
 * TeamChannel.tsx — the main "Team chat" conversation of the Team tab
 * (v2.1 typical-chat layout, 2026-08-28 notes).
 *
 * One time-ordered conversation with the orchestrator: the Coordinator
 * dispatches each autopilot run as a message, raises each unanswered question
 * to the human, and the live chat session continues underneath — the same
 * shared session store the Chat tab drives. Dispatch messages carry a small
 * inline "view updates" affordance (the replies-badge pattern) that selects
 * that run's conversation instead of opening a panel over this one.
 *
 * Styling is deliberately monochrome: identity lives in the avatar, names are
 * plain foreground at medium weight, and the single accent (primary) is
 * reserved for count badges.
 */

import type { ReactNode } from "react"
import { MessageCircleQuestion } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerEndOnSignal,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { AGENT_PERSONAS } from "@/lib/agent/personas"
import type { AgentRunUi } from "@/lib/agent/run-state"
import type { TeamChannelItem, TeamDispatchItem } from "@/lib/agent/team-channel"
import { AgentRunView } from "./AgentRunView"
import { PersonaAvatar } from "./PersonaAvatar"
import { isRunWorking, runStatusKey } from "./team-run-status"

export interface TeamChannelProps {
  items: TeamChannelItem[]
  /** Display title for a dispatch message — the file name where known. */
  titleFor: (item: TeamDispatchItem) => string
  /** Select a run's conversation ("view updates" on a dispatch). */
  onOpenThread: (threadId: string) => void
  /** Select the questions conversation ("answer" on a question message). */
  onOpenQuestions: () => void
  /** Open questions the server withheld beyond its visible cap. */
  heldQuestions: number
  /** Runs of the shared conversational session, oldest first. */
  conversationRuns: readonly AgentRunUi[]
  /** Sends a tapped next-step suggestion as the next channel message. */
  onSuggestionSend?: (text: string) => void
  /** Bumped on the viewer's own sends — snaps the feed back to the end. */
  sendSignal?: number
}

function ChannelMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full items-start gap-2 px-2 py-1.5">
      <PersonaAvatar personaId="coordinator" className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
    </div>
  )
}

export function TeamChannel({
  items,
  titleFor,
  onOpenThread,
  onOpenQuestions,
  heldQuestions,
  conversationRuns,
  onSuggestionSend,
  sendSignal = 0,
}: TeamChannelProps) {
  const { locale, t } = useI18n()
  const coordinatorName = t(AGENT_PERSONAS.coordinator.nameKey)
  return (
    // Stick-to-bottom feed (2026-08-31 review): new messages follow while the
    // reader is at the bottom; scrolling up breaks the follow until the
    // ArrowDown button (or scrolling back down) re-engages it.
    <MessageScrollerProvider autoScroll scrollEdgeThreshold={64}>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerEndOnSignal signal={sendSignal} />
        <MessageScrollerViewport>
          <MessageScrollerContent
            className="mx-auto flex w-full max-w-2xl flex-col gap-2 p-3"
            data-testid="team-channel"
          >
        {items.map((item) => {
          if (item.kind === "dispatch") {
            const title = titleFor(item)
            const time = new Date(item.at).toLocaleTimeString(locale, {
              hour: "2-digit",
              minute: "2-digit",
            })
            const drafts = item.run.proposedDrafts ?? 0
            return (
              <ChannelMessage key={item.id}>
                <span className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-foreground">{coordinatorName}</span>
                  <span className="text-[10px] text-muted-foreground">{time}</span>
                </span>
                <span className="text-sm leading-relaxed">
                  {t("agent.team.msg.dispatch", { file: title })}
                </span>
                {/* The replies-badge pattern: a quiet inline affordance under
                    the message, not a whole-row jump. */}
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {isRunWorking(item.run) && <Spinner className="h-2.5 w-2.5 shrink-0" />}
                  <span className="truncate">{t(runStatusKey(item.run))}</span>
                  <button
                    type="button"
                    onClick={() => onOpenThread(item.threadId)}
                    aria-label={t("agent.team.openThreadAriaLabel", { title })}
                    className="flex shrink-0 items-center gap-1 font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {t("agent.team.viewUpdates")}
                    {drafts > 0 && (
                      <Badge className="h-4 min-w-4 px-1 text-[10px]">{drafts}</Badge>
                    )}
                  </button>
                </span>
              </ChannelMessage>
            )
          }
          return (
            <ChannelMessage key={item.id}>
              <span className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-foreground">{coordinatorName}</span>
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                  <MessageCircleQuestion className="h-3 w-3" aria-hidden />
                  {t("agent.team.needsYou")}
                </span>
              </span>
              <span className="text-sm leading-relaxed">{item.decision.reason}</span>
              <button
                type="button"
                onClick={onOpenQuestions}
                aria-label={t("agent.team.openQuestionAriaLabel")}
                className="w-fit text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {t("agent.team.answerQuestion")}
              </button>
            </ChannelMessage>
          )
        })}
        {heldQuestions > 0 && (
          <p className="px-2 text-xs text-muted-foreground">
            {t("autopilot.decisions.held", { count: heldQuestions })}
          </p>
        )}
            {conversationRuns.map((run, runIndex) => (
              // Proposals are deliberately NOT rendered here: the Chat tab remains
              // the full working surface (Apply/Undo wiring, working set, receipts).
              // The channel narrates the conversation; omitting renderProposal is
              // what keeps the two surfaces from offering the same Apply twice.
              <div key={run.localId} className="border-t border-border/40 px-2 pt-3 first:border-t-0">
                <AgentRunView
                  run={run}
                  onSuggestionSend={
                    runIndex === conversationRuns.length - 1 ? onSuggestionSend : undefined
                  }
                />
              </div>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton className="shadow-sm" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
