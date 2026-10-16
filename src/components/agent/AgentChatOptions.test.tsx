// AQU-1774 adds the labelled surface below: on the workbench, New chat is a
// visible text button and the menu beside it is named for what it holds, so
// neither the action nor the chat list depends on hovering an icon.
//
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

// AQU-1774: the reported bug was discoverability, not safety — AQU-1653 had
// already made starting a new chat recoverable, but it lived behind an
// icon-only "…" trigger, so nothing on screen said "new chat" and users read
// the icon as a destructive reset. On the labelled surface the action is a
// button with words on it, and the menu next to it is the chat list by name.
describe("AgentChatOptions — labelled surface", () => {
  it("offers New chat as a visible text button, no menu to open first", async () => {
    const user = userEvent.setup()
    const onNewChat = vi.fn()
    render(<AgentChatOptions labelled onNewChat={onNewChat} sessions={SESSIONS} currentSessionId="s-new" />)

    const button = screen.getByRole("button", { name: "New chat" })
    // The whole point: the label is readable text, not an aria-label standing
    // in for an unlabelled glyph.
    expect(button).toHaveTextContent("New chat")
    expect(screen.queryByRole("button", { name: "Chat options" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument()

    await user.click(button)
    expect(onNewChat).toHaveBeenCalledTimes(1)
    // Still no confirmation: the action is not destructive (AQU-1653).
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("keeps the honest caveat on the button it belongs to", async () => {
    const user = userEvent.setup()
    render(<AgentChatOptions labelled onNewChat={vi.fn()} sessions={SESSIONS} currentSessionId="s-new" />)

    await user.hover(screen.getByRole("button", { name: "New chat" }))
    const tip = await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent(/reopen it under Previous chats/i)
    expect(tip).toHaveTextContent(/not the proposal cards/i)
  })

  it("names the chats menu for what it holds and opens the chat chosen", async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    render(
      <AgentChatOptions
        labelled
        onNewChat={vi.fn()}
        sessions={SESSIONS}
        currentSessionId="s-new"
        onOpenSession={onOpenSession}
      />,
    )

    const trigger = screen.getByRole("button", { name: "Previous chats" })
    expect(trigger).toHaveTextContent("Previous chats")
    await user.click(trigger)

    const rows = await screen.findAllByTestId("agent-chat-history-item")
    expect(rows.map((row) => row.textContent)).toEqual([
      "Why is MRK 4 flagged? — open now",
      "Draft GEN 1",
      "Untitled chat",
    ])
    // The trigger says "Previous chats", so repeating it as an inert row
    // inside would be chrome for its own sake.
    expect(screen.queryByRole("menuitem", { name: "Previous chats" })).not.toBeInTheDocument()
    // New chat stays out of this menu — it is the button next to it.
    expect(screen.queryByRole("menuitem", { name: /New chat/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole("menuitem", { name: "Draft GEN 1" }))
    expect(onOpenSession).toHaveBeenCalledWith("s-old")
  })

  it("still says the list failed rather than showing it as empty", async () => {
    const user = userEvent.setup()
    render(<AgentChatOptions labelled onNewChat={vi.fn()} historyStatus="error" />)

    await user.click(screen.getByRole("button", { name: "Previous chats" }))
    expect(await screen.findByRole("menuitem", { name: "Couldn't load your chats." })).toBeInTheDocument()
  })

  it("blocks the labelled New chat button while an apply or undo is in progress", async () => {
    const onNewChat = vi.fn()
    render(<AgentChatOptions labelled onNewChat={onNewChat} sessions={SESSIONS} currentSessionId="s-new" disabled />)

    const button = screen.getByRole("button", { name: "New chat" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onNewChat).not.toHaveBeenCalled()
  })
})
