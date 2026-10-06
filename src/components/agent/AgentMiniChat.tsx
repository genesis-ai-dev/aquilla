/**
 * AgentMiniChat.tsx — the floating AI mini-chat (AQU-1651).
 *
 * "Ask AI" used to take the reader out of the translation view and into the
 * full agent surface, which costs them the passage they were working on. This
 * is the cheap answer: the same conversation, in a small window that floats
 * over the workspace so the source, the target and the neighbouring cells stay
 * readable behind it.
 *
 * It is a frame, not a second chat stack. The body is `AgentDockView`, which
 * mounts the project's shared agent session (`src/lib/agent/session-store.ts`),
 * so the mini-chat, the dock and the full workbench are the SAME conversation —
 * a run started here keeps streaming after the window is closed, and the thread
 * shows up in the AI management tab like any other. The thread switcher is the
 * workbench's own `AgentChatOptions`, for the same reason.
 *
 * What the frame owns is only where it sits: dragging, the collapsed bar, and
 * the per-user placement memory in `src/lib/agent/mini-chat-window.ts`.
 * Closing the window closes the FRAME — the thread stays on the server and is
 * one click away under "Previous chats".
 *
 * Below `lg` there is nowhere to drag to, so the window becomes a bottom sheet
 * and the bar a full-width strip; placement is not persisted in that mode
 * because there is only one place it can be.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Maximize2, MessageSquare, Minus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { useIsLgUp } from "@/hooks/useIsLgUp"
import { useAgentSession } from "@/lib/agent/session-store"
import { useAgentSessionHistory } from "@/hooks/useAgentSessionHistory"
import { fetchAgentSession, runsFromTurns } from "@/lib/agent/session-history"
import {
  clampMiniChatPoint,
  currentMiniChatViewport,
  miniChatSize,
  readMiniChatPlacement,
  writeMiniChatPlacement,
  type MiniChatPlacement,
  type MiniChatPoint,
} from "@/lib/agent/mini-chat-window"
import { AgentChatOptions } from "./AgentChatOptions"
import { AgentDockView, type AgentDockViewProps } from "./AgentDockView"

export interface AgentMiniChatProps {
  /** Whether the frame is on screen. The thread outlives it either way. */
  open: boolean
  /** Dismiss the frame. Must not end or delete the conversation. */
  onClose: () => void
  /** Hand the current thread to the full AI chat surface for longer work. */
  onExpand: () => void
  /** Everything the shared chat body needs; passed straight through. */
  agent: AgentDockViewProps
}

export function AgentMiniChat(props: AgentMiniChatProps) {
  // A different project, or a different signed-in user, is a different
  // window with its own remembered resting place — so it is a different
  // mount, the same way AgentDockView scopes its composer draft.
  const owner = `${props.agent.projectId}:${props.agent.author}`
  return <ScopedAgentMiniChat key={owner} owner={owner} {...props} />
}

function ScopedAgentMiniChat({
  owner,
  open,
  onClose,
  onExpand,
  agent,
}: AgentMiniChatProps & { owner: string }) {
  const t = useT()
  const isLgUp = useIsLgUp()
  const floating = isLgUp

  const [placement, setPlacement] = useState<MiniChatPlacement>(() =>
    readMiniChatPlacement(owner, currentMiniChatViewport()),
  )

  // A window parked near an edge must not fall off it when the viewport
  // shrinks (a resized browser, a rotated tablet, a dock opening).
  useEffect(() => {
    const onResize = () => {
      setPlacement((previous) => ({
        ...previous,
        ...clampMiniChatPoint(previous, miniChatSize(previous.minimized), currentMiniChatViewport()),
      }))
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // Collapsing and reopening are explicit choices about how the reader wants
  // the chat to rest, so both are written through. The write is a plain
  // effect of the click, never inside a state updater — React may run an
  // updater more than once.
  const setMinimized = useCallback(
    (minimized: boolean) => {
      const next: MiniChatPlacement = {
        ...clampMiniChatPoint(placement, miniChatSize(minimized), currentMiniChatViewport()),
        minimized,
      }
      setPlacement(next)
      writeMiniChatPlacement(owner, next)
    },
    [owner, placement],
  )

  // Drag state lives in a ref: a pointer move must not wait on a render, and
  // the "did it actually move" flag is what tells a click on the collapsed bar
  // apart from the end of a drag of it.
  const dragRef = useRef<{ dx: number; dy: number; moved: boolean; point: MiniChatPoint } | null>(null)
  // A drag that ends on the collapsed bar also produces a click on it. The
  // drag itself is over by then, so the "it moved" fact has to outlive it —
  // otherwise parking the bar somewhere reopens the window.
  const justDraggedRef = useRef(false)
  const minimized = placement.minimized

  const handleDragStart = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!floating || event.button !== 0) return
      // The header carries buttons and the thread menu; pressing one of those
      // is not a drag.
      if ((event.target as HTMLElement | null)?.closest("button, [role='menuitem'], input, textarea")) return
      justDraggedRef.current = false
      dragRef.current = {
        dx: event.clientX - placement.x,
        dy: event.clientY - placement.y,
        moved: false,
        point: { x: placement.x, y: placement.y },
      }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [floating, placement.x, placement.y],
  )

  const handleDragMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current
      if (!drag) return
      drag.moved = true
      const point = clampMiniChatPoint(
        { x: event.clientX - drag.dx, y: event.clientY - drag.dy },
        miniChatSize(minimized),
        currentMiniChatViewport(),
      )
      drag.point = point
      setPlacement((previous) => ({ ...previous, ...point }))
    },
    [minimized],
  )

  const handleDragEnd = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!dragRef.current) return
      const { moved, point } = dragRef.current
      dragRef.current = null
      justDraggedRef.current = moved
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      // Only a drag that went somewhere is worth remembering.
      if (moved) writeMiniChatPlacement(owner, { ...point, minimized })
    },
    [owner, minimized],
  )

  // A fresh "Ask AI" must land somewhere the reader can see it. While the
  // window is collapsed the chat body is not mounted, so a question asked
  // into the bar would never reach a composer at all — the window has to
  // come back. Adjusted during render rather than in an effect (the React
  // "state derived from a prop change" pattern) so the bar never paints for
  // a frame before vanishing. Deliberately NOT persisted: the reader did not
  // choose this resting state, so their own last choice is what is restored
  // next session.
  const pendingChip = agent.pendingChip
  const [seenChip, setSeenChip] = useState(pendingChip)
  if (seenChip !== pendingChip) {
    setSeenChip(pendingChip)
    if (pendingChip && placement.minimized) {
      setPlacement((previous) => ({
        ...clampMiniChatPoint(previous, miniChatSize(false), currentMiniChatViewport()),
        minimized: false,
      }))
    }
  }

  const dragHandlers = floating
    ? {
        onPointerDown: handleDragStart,
        onPointerMove: handleDragMove,
        onPointerUp: handleDragEnd,
        onPointerCancel: handleDragEnd,
      }
    : {}

  // The thread switcher — the same menu the full workbench uses, over the same
  // shared session, so switching here switches there too.
  const { state, startNewChat, switchTo } = useAgentSession(agent.projectId, agent.author)
  const chatHistory = useAgentSessionHistory(agent.jwt, agent.projectId)
  const [switching, setSwitching] = useState(false)
  const openPastChat = useCallback(
    async (sessionId: string) => {
      if (!agent.jwt) return
      setSwitching(true)
      try {
        const past = await fetchAgentSession(agent.jwt, agent.projectId, sessionId)
        switchTo(sessionId, runsFromTurns(past.turns))
      } catch {
        // A failed switch must leave the conversation on screen exactly as it
        // was; reload the list in case the chat is simply gone.
        chatHistory.reload()
      } finally {
        setSwitching(false)
      }
    },
    [agent.jwt, agent.projectId, switchTo, chatHistory],
  )
  const beginNewChat = useCallback(() => {
    startNewChat()
    chatHistory.reload()
  }, [startNewChat, chatHistory])

  const title = useMemo(() => {
    const current = chatHistory.sessions.find((s) => s.sessionId === state.sessionId)
    const named = current?.title.trim()
    return named ? named : t("agent.miniChat.title")
  }, [chatHistory.sessions, state.sessionId, t])

  if (!open) return null

  const size = miniChatSize(minimized)
  const frameStyle = floating
    ? { left: placement.x, top: placement.y, width: size.width, height: size.height }
    : undefined

  if (minimized) {
    return (
      <div
        data-testid="agent-mini-chat-bar"
        style={frameStyle}
        className={
          floating
            ? "fixed z-50 flex items-center gap-1 overflow-hidden rounded-full border border-border bg-background pe-1 shadow-lg"
            : "fixed inset-x-0 bottom-0 z-50 flex items-center gap-1 border-t border-border bg-background pe-1 shadow-lg"
        }
        {...dragHandlers}
      >
        <button
          type="button"
          data-testid="agent-mini-chat-restore"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-start"
          onClick={() => {
            // The pointer-up that ends a drag also fires a click; parking the
            // bar somewhere is not a request to reopen it.
            if (justDraggedRef.current) {
              justDraggedRef.current = false
              return
            }
            setMinimized(false)
          }}
        >
          <MessageSquare aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-xs font-medium">{title}</span>
          <span className="sr-only">{t("agent.miniChat.restore")}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("agent.miniChat.close")}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
    )
  }

  return (
    <div
      data-testid="agent-mini-chat"
      role="dialog"
      aria-label={t("agent.miniChat.windowLabel")}
      style={frameStyle}
      className={
        floating
          ? "fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
          : "fixed inset-x-0 bottom-0 z-50 flex h-[70vh] flex-col overflow-hidden rounded-t-xl border border-border bg-background shadow-xl"
      }
    >
      <div
        data-testid="agent-mini-chat-handle"
        className={`flex shrink-0 items-center gap-1 border-b border-border/60 bg-muted/40 ps-3 pe-1 py-1.5${floating ? " cursor-grab active:cursor-grabbing" : ""}`}
        {...dragHandlers}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</span>
        <AgentChatOptions
          onNewChat={beginNewChat}
          sessions={chatHistory.sessions}
          historyStatus={chatHistory.status}
          currentSessionId={state.sessionId}
          onOpenSession={openPastChat}
          disabled={switching}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("agent.miniChat.expand")}
          data-testid="agent-mini-chat-expand"
          onClick={onExpand}
        >
          <Maximize2 />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("agent.miniChat.minimize")}
          data-testid="agent-mini-chat-minimize"
          onClick={() => setMinimized(true)}
        >
          <Minus />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("agent.miniChat.close")}
          data-testid="agent-mini-chat-close"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <AgentDockView {...agent} />
    </div>
  )
}
