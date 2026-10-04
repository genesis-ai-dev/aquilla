// AQU-1653: the chat menu's job changed. It used to guard one destructive
// "Reset chat…" behind a confirmation, because a reset put the conversation out
// of reach. Now the server lists a user's past chats back, so the menu starts a
// new chat outright and offers the old ones. These tests encode what makes that
// safe rather than reckless: the new-chat item SAYS what does and does not come
// back, the chat on screen cannot be re-opened onto itself (which would trade a
// live timeline for a prose transcript), a failed list read says so instead of
// looking like an empty history, and nothing switches chats mid-apply.

import { beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentChatOptions } from "./AgentChatOptions"
import type { AgentSessionSummary } from "@/lib/agent/session-history"

beforeAll(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  })
})

const SESSIONS: AgentSessionSummary[] = [
  { sessionId: "s-new", title: "Why is MRK 4 flagged?", createdAt: 2, updatedAt: 20 },
  { sessionId: "s-old", title: "Draft GEN 1", createdAt: 1, updatedAt: 10 },
  { sessionId: "s-blank", title: "", createdAt: 0, updatedAt: 5 },
]

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Chat options" }))
}

describe("AgentChatOptions", () => {
  it("starts a new chat without a confirmation, and says what a reopened chat keeps", async () => {
    const user = userEvent.setup()
    const onNewChat = vi.fn()
    render(<AgentChatOptions onNewChat={onNewChat} sessions={SESSIONS} currentSessionId="s-new" />)
    await openMenu(user)

    const item = await screen.findByRole("menuitem", { name: /New chat/ })
    // The caveat is the whole reason no dialog is needed: the conversation is
    // saved, the proposal cards are not.
    expect(item).toHaveAccessibleDescription(/reopen it under Previous chats/i)
    expect(item).toHaveAccessibleDescription(/not the proposal cards/i)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()

    await user.click(item)
    expect(onNewChat).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("lists the caller's past chats newest first and opens the one chosen", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    render(
      <AgentChatOptions
        onNewChat={vi.fn()}
        sessions={SESSIONS}
        currentSessionId="s-new"
        onOpenSession={onOpenSession}
      />,
    )
    await openMenu(user)

    const rows = await screen.findAllByTestId("agent-chat-history-item")
    expect(rows.map((row) => row.textContent)).toEqual([
      "Why is MRK 4 flagged? — open now",
      "Draft GEN 1",
      // A chat with no first user message still has to be nameable.
      "Untitled chat",
    ])

    await user.click(screen.getByRole("menuitem", { name: "Draft GEN 1" }))
    expect(onOpenSession).toHaveBeenCalledWith("s-old")
  })

  it("will not reopen the chat already on screen", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    render(
      <AgentChatOptions
        onNewChat={vi.fn()}
        sessions={SESSIONS}
        currentSessionId="s-new"
        onOpenSession={onOpenSession}
      />,
    )
    await openMenu(user)

    const current = await screen.findByRole("menuitem", { name: /Why is MRK 4 flagged\? — open now/ })
    expect(current).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(current)
    expect(onOpenSession).not.toHaveBeenCalled()
  })

  it("says the list failed rather than showing it as empty", async () => {
    const user = userEvent.setup()
    render(<AgentChatOptions onNewChat={vi.fn()} historyStatus="error" />)
    await openMenu(user)

    expect(await screen.findByRole("menuitem", { name: "Couldn't load your chats." })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "No previous chats" })).not.toBeInTheDocument()
  })

  it("distinguishes a list still loading from a user with no chats", async () => {
    const user = userEvent.setup()
    const view = render(<AgentChatOptions onNewChat={vi.fn()} historyStatus="loading" />)
    await openMenu(user)
    expect(await screen.findByRole("menuitem", { name: "Loading your chats…" })).toBeInTheDocument()

    await user.keyboard("{Escape}")
    view.rerender(<AgentChatOptions onNewChat={vi.fn()} historyStatus="ready" sessions={[]} />)
    await openMenu(user)
    expect(await screen.findByRole("menuitem", { name: "No previous chats" })).toBeInTheDocument()
  })

  it("blocks both new chat and chat switching while an apply or undo is in progress", async () => {
    const user = userEvent.setup()
    const onNewChat = vi.fn()
    const onOpenSession = vi.fn()
    render(
      <AgentChatOptions
        onNewChat={onNewChat}
        sessions={SESSIONS}
        currentSessionId="s-new"
        onOpenSession={onOpenSession}
        disabled
      />,
    )
    await openMenu(user)

    const newChat = await screen.findByRole("menuitem", { name: /New chat/ })
    expect(newChat).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(newChat)
    expect(onNewChat).not.toHaveBeenCalled()

    const past = screen.getByRole("menuitem", { name: "Draft GEN 1" })
    expect(past).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(past)
    expect(onOpenSession).not.toHaveBeenCalled()
  })
})
