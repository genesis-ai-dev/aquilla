/**
 * AgentChatOptions.tsx — the workbench's chat-management menu: start a new
 * chat, or reopen one of your own past ones.
 *
 * AQU-1653 changed what this menu is. It used to hold a single destructive
 * "Reset chat…" behind a confirmation dialog, because resetting was a one-way
 * door: the client knew only the one session id it had in localStorage, so a
 * reset put the conversation out of reach. The server has always persisted
 * every chat under `agent_sessions`, and now lists them back, so starting a
 * new chat is an ordinary, recoverable action — no confirmation, and the chat
 * being left is one click away under "Previous chats".
 *
 * One honest caveat, carried in the item's description rather than a dialog: a
 * reopened chat shows the CONVERSATION, not the live run chrome. Tool chips and
 * proposal cards belonged to the run that was streaming at the time; the model
 * loses nothing (the server still holds the full conversation, tool results
 * included), but those cards do not come back.
 */

import { MessageSquarePlus } from "lucide-react"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import type { AgentSessionSummary } from "@/lib/agent/session-history"
import { useT } from "@/lib/i18n/I18nProvider"

/** How the caller's chat list is doing, so the menu can say so in place of
 *  silently showing nothing. */
export type ChatHistoryStatus = "loading" | "ready" | "error"

export function AgentChatOptions({
  onNewChat,
  sessions = [],
  currentSessionId,
  onOpenSession,
  historyStatus = "ready",
  disabled = false,
}: {
  /** Start a fresh conversation. The current one stays on the server. */
  onNewChat: () => void
  /** The caller's own chats, newest first. */
  sessions?: readonly AgentSessionSummary[]
  /** The chat on screen — listed, but not re-openable onto itself. */
  currentSessionId?: string
  /** Reopen a past chat. Omitted → the list is shown but inert. */
  onOpenSession?: (sessionId: string) => void
  historyStatus?: ChatHistoryStatus
  /** Do not switch chats while an apply or undo is in flight — the apply
   *  targets rows in the conversation that is about to be replaced. */
  disabled?: boolean
}) {
  const t = useT()

  const historyItems = (): OverflowMenuItem[] => {
    if (historyStatus === "loading") {
      return [{ id: "chats-loading", label: t("agent.chatOptions.previousLoading"), disabled: true }]
    }
    if (historyStatus === "error") {
      return [{ id: "chats-error", label: t("agent.chatOptions.previousFailed"), disabled: true }]
    }
    if (sessions.length === 0) {
      return [{ id: "chats-empty", label: t("agent.chatOptions.previousEmpty"), disabled: true }]
    }
    return sessions.map((session) => {
      const name = session.title.trim() || t("agent.chatOptions.untitledChat")
      const isCurrent = session.sessionId === currentSessionId
      return {
        id: `chat-${session.sessionId}`,
        label: isCurrent ? t("agent.chatOptions.openChat", { title: name }) : name,
        // The chat already on screen is listed so the user can see where they
        // are, but choosing it would replace the live timeline (cards and all)
        // with its prose transcript — a pure loss.
        disabled: isCurrent || disabled || !onOpenSession,
        onClick: isCurrent ? undefined : () => onOpenSession?.(session.sessionId),
        testId: `agent-chat-history-item`,
      }
    })
  }

  return (
    <OverflowMenu
      ariaLabel={t("agent.chatOptions.label")}
      triggerSize="icon-sm"
      testId="agent-chat-options"
      items={[
        {
          id: "new-chat",
          label: t("agent.chatOptions.newChat"),
          icon: MessageSquarePlus,
          description: t("agent.chatOptions.newChatDescription"),
          disabled,
          onClick: onNewChat,
          testId: "agent-new-chat",
        },
        { id: "chats-sep", type: "separator" },
        { id: "chats-heading", label: t("agent.chatOptions.previousHeading"), disabled: true },
        ...historyItems(),
      ]}
    />
  )
}
