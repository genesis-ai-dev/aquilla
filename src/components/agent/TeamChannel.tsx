/**
 * TeamChannel.tsx — the main channel of the one-channel Team tab (v2 of the
 * 2026-08-28 social-workspace design).
 *
 * One time-ordered project conversation: the Coordinator dispatches each
 * autopilot run as a message that OWNS a thread, raises each unanswered
 * question as a message addressed to the human (also threaded), and the live
 * chat session continues underneath — same shared session store as the Chat
 * tab, so a run started in either place shows in both.
 */

import type { ReactNode } from "react"
import { MessageCircleQuestion } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
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
  onOpenThread: (threadId: string) => void
  /** Open questions the server withheld beyond its visible cap. */
  heldQuestions: number
  /** Runs of the shared conversational session, oldest first. */
  conversationRuns: readonly AgentRunUi[]
}

function MessageShell({
  onOpen,
  ariaLabel,
  children,
}: {
  onOpen: () => void
  ariaLabel: string
  children: ReactNode
}) {
  const persona = AGENT_PERSONAS.coordinator
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaLabel}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start transition-colors hover:bg-accent/60 active:scale-[0.995]"
    >
      <PersonaAvatar personaId={persona.id} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
    </button>
  )
}

export function TeamChannel({
  items,
  titleFor,
  onOpenThread,
  heldQuestions,
  conversationRuns,
}: TeamChannelProps) {
  const { locale, t } = useI18n()
  const coordinator = AGENT_PERSONAS.coordinator
  const coordinatorName = t(coordinator.nameKey)
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div
        className="mx-auto flex max-w-2xl flex-col gap-2 p-3"
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
              <MessageShell
                key={item.id}
                onOpen={() => onOpenThread(item.threadId)}
                ariaLabel={t("agent.team.openThreadAriaLabel", { title })}
              >
                <span className="flex items-baseline gap-2">
                  <span className={cn("text-xs font-medium", coordinator.textClass)}>
                    {coordinatorName}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{time}</span>
                </span>
                <span className="text-sm leading-relaxed">
                  {t("agent.team.msg.dispatch", { file: title })}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {isRunWorking(item.run) && <Spinner className="h-2.5 w-2.5 shrink-0" />}
                  <span className="truncate">{t(runStatusKey(item.run))}</span>
                  {drafts > 0 && (
                    <Badge className="h-4 min-w-4 px-1 text-[10px]">{drafts}</Badge>
                  )}
                </span>
              </MessageShell>
            )
          }
          return (
            <MessageShell
              key={item.id}
              onOpen={() => onOpenThread(item.threadId)}
              ariaLabel={t("agent.team.openQuestionAriaLabel")}
            >
              <span className="flex items-baseline gap-2">
                <span className={cn("text-xs font-medium", coordinator.textClass)}>
                  {coordinatorName}
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  <MessageCircleQuestion className="h-3 w-3" aria-hidden />
                  {t("agent.team.needsYou")}
                </span>
              </span>
              <span className="text-sm leading-relaxed">{item.decision.reason}</span>
            </MessageShell>
          )
        })}
        {heldQuestions > 0 && (
          <p className="px-2 text-xs text-muted-foreground">
            {t("autopilot.decisions.held", { count: heldQuestions })}
          </p>
        )}
        {conversationRuns.map((run) => (
          // Proposals are deliberately NOT rendered here: the Chat tab remains
          // the full working surface (Apply/Undo wiring, working set, receipts).
          // The channel narrates the conversation; omitting renderProposal is
          // what keeps the two surfaces from offering the same Apply twice.
          <div key={run.localId} className="border-t border-border/40 px-2 pt-3 first:border-t-0">
            <AgentRunView run={run} />
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
