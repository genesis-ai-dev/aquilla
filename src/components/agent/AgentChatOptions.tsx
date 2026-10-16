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
 *
 * AQU-1774 then split the menu in two by surface. AQU-1653 made starting a new
 * chat safe, but left it reachable only by opening an icon-only "..." trigger,
 * so on the workbench — where users go specifically to manage chats — there was
 * nothing on screen that said "new chat". The `labelled` surface therefore
 * promotes New chat to a visible, text-labelled button and names the menu
 * beside it "Previous chats", so both the action and the list read without
 * hovering an icon. Compact surfaces (the floating mini-chat's title bar, which
 * has room for icon-xs chrome only) keep the single icon menu, New chat at its
 * top.
 */

import { History, MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
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
  labelled = false,
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
  /** AQU-1774: on a surface with room for text (the workbench toolbar), show
   *  New chat as its own labelled button and name the chats menu beside it.
   *  Left false, the whole thing stays one icon menu for cramped chrome. */
  labelled?: boolean
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

  const newChatItem: OverflowMenuItem = {
    id: "new-chat",
    label: t("agent.chatOptions.newChat"),
    icon: MessageSquarePlus,
    description: t("agent.chatOptions.newChatDescription"),
    disabled,
    onClick: onNewChat,
    testId: "agent-new-chat",
  }

  if (labelled) {
    return (
      <div className="flex items-center gap-1">
        {/* The caveat stays attached to the action, now as the button's own
            tooltip: nothing about this surface is destructive, so it informs
            rather than warns, and the copy is the same sentence the menu item
            carries on compact surfaces. */}
        <AppTooltip content={t("agent.chatOptions.newChatDescription")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onNewChat}
            data-testid="agent-new-chat"
          >
            <MessageSquarePlus data-icon="inline-start" />
            {t("agent.chatOptions.newChat")}
          </Button>
        </AppTooltip>
        {/* New chat has left the menu, so the menu IS the chat list — it says
            so on its face, and the in-menu heading would only repeat it. */}
        <OverflowMenu
          ariaLabel={t("agent.chatOptions.previousHeading")}
          triggerLabel={t("agent.chatOptions.previousHeading")}
          triggerIcon={History}
          triggerSize="sm"
          testId="agent-chat-options"
          items={historyItems()}
        />
      </div>
    )
  }

  return (
    <OverflowMenu
      ariaLabel={t("agent.chatOptions.label")}
      triggerSize="icon-sm"
      testId="agent-chat-options"
      items={[
        newChatItem,
        { id: "chats-sep", type: "separator" },
        { id: "chats-heading", label: t("agent.chatOptions.previousHeading"), disabled: true },
        ...historyItems(),
      ]}
    />
  )
}
