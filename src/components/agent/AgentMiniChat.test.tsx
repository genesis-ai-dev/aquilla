// AQU-1651: "Ask AI" used to take the reader out of the translation view. The
// mini-chat's whole value is that it does not, so these tests hold the frame
// to that promise: it floats (it is not a modal and does not replace the
// workspace), it goes where the reader puts it and stays there, it collapses
// to a bar that reopens, expanding hands the SAME thread to the full surface,
// and closing the window is not closing the conversation — nothing in the
// shared session store is reset, started over or switched.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AgentSessionSummary } from "@/lib/agent/session-history"
import { AgentMiniChat } from "./AgentMiniChat"
import {
  MINI_CHAT_BAR_SIZE,
  MINI_CHAT_WINDOW_SIZE,
  readMiniChatPlacement,
} from "@/lib/agent/mini-chat-window"
import { STALL_WATCHDOG_MS } from "@/test-utils/timeouts"

// The body is the shared dock view; this suite is about the frame around it.
vi.mock("./AgentDockView", () => ({
  AgentDockView: (props: { projectId: string }) => (
    <div data-testid="agent-dock-view">dock:{props.projectId}</div>
  ),
}))

let isLgUp = true
vi.mock("@/hooks/useIsLgUp", () => ({ useIsLgUp: () => isLgUp }))

const SESSIONS: AgentSessionSummary[] = [
  { sessionId: "s-live", title: "Why is MRK 4 flagged?", createdAt: 2, updatedAt: 20 },
  { sessionId: "s-old", title: "Draft GEN 1", createdAt: 1, updatedAt: 10 },
]

const reload = vi.fn()
vi.mock("@/hooks/useAgentSessionHistory", () => ({
  useAgentSessionHistory: () => ({ sessions: SESSIONS, status: "ready" as const, reload }),
}))

const switchTo = vi.fn()
const startNewChat = vi.fn()
const reset = vi.fn()
vi.mock("@/lib/agent/session-store", () => ({
  useAgentSession: () => ({
    state: { sessionId: "s-live", runs: [], isStreaming: false, decided: new Map() },
    send: vi.fn(),
    stop: vi.fn(),
    reset,
    startNewChat,
    switchTo,
    decide: vi.fn(),
    noteActivity: vi.fn(),
  }),
}))

const fetchAgentSession = vi.fn(async () => ({
  sessionId: "s-old",
  title: "Draft GEN 1",
  createdAt: 1,
  updatedAt: 10,
  turns: [{ role: "user" as const, text: "hello" }],
}))
vi.mock("@/lib/agent/session-history", () => ({
  fetchAgentSession: (...args: unknown[]) => fetchAgentSession(...(args as [])),
  runsFromTurns: () => [],
}))

const OWNER = "proj-1:ada"
const AGENT = {
  projectId: "proj-1",
  jwt: "jwt-1",
  author: "ada",
  roleLevel: 40,
  context: {},
  rules: [],
}

function renderMiniChat(overrides: Partial<Parameters<typeof AgentMiniChat>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    onExpand: vi.fn(),
    agent: AGENT,
    ...overrides,
  }
  return { ...render(<AgentMiniChat {...props} />), props }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  isLgUp = true
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 })
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] })
})

describe("AgentMiniChat", () => {
  it("renders nothing while closed", () => {
    renderMiniChat({ open: false })
    expect(screen.queryByTestId("agent-mini-chat")).not.toBeInTheDocument()
  })

  it("floats the shared chat body over the workspace rather than replacing it", () => {
    renderMiniChat()
    const frame = screen.getByTestId("agent-mini-chat")
    // Non-modal on purpose: the source and target stay readable behind it, so
    // it must not be announced (or behave) as a modal dialog.
    expect(frame).toHaveAttribute("role", "dialog")
    expect(frame).not.toHaveAttribute("aria-modal", "true")
    expect(frame.className).toContain("fixed")
    expect(screen.getByTestId("agent-dock-view")).toHaveTextContent("dock:proj-1")
  })

  it("opens at the stored position and stays there", () => {
    localStorage.setItem(
      `aq.agent-mini-chat.v1:${OWNER}`,
      JSON.stringify({ x: 220, y: 140, minimized: false }),
    )
    renderMiniChat()
    expect(screen.getByTestId("agent-mini-chat")).toHaveStyle({ left: "220px", top: "140px" })
  })

  it("moves with a drag of its header and remembers where it was dropped", () => {
    localStorage.setItem(
      `aq.agent-mini-chat.v1:${OWNER}`,
      JSON.stringify({ x: 200, y: 200, minimized: false }),
    )
    renderMiniChat()
    const handle = screen.getByTestId("agent-mini-chat-handle")
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 250, clientY: 220 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 350, clientY: 320 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 350, clientY: 320 })

    expect(screen.getByTestId("agent-mini-chat")).toHaveStyle({ left: "300px", top: "300px" })
    expect(readMiniChatPlacement(OWNER, { width: 1440, height: 900 })).toEqual({
      x: 300,
      y: 300,
      minimized: false,
    })
  })

  it("does not drag when the press lands on a header button", () => {
    localStorage.setItem(
      `aq.agent-mini-chat.v1:${OWNER}`,
      JSON.stringify({ x: 200, y: 200, minimized: false }),
    )
    renderMiniChat()
    const handle = screen.getByTestId("agent-mini-chat-handle")
    fireEvent.pointerDown(screen.getByTestId("agent-mini-chat-close"), {
      button: 0, pointerId: 1, clientX: 250, clientY: 220,
    })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600, clientY: 600 })
    expect(screen.getByTestId("agent-mini-chat")).toHaveStyle({ left: "200px", top: "200px" })
  })

  it("minimizes to a bar that reopens the window, and remembers the collapsed state", async () => {
    const user = userEvent.setup()
    renderMiniChat()
    await user.click(screen.getByTestId("agent-mini-chat-minimize"))

    expect(screen.queryByTestId("agent-mini-chat")).not.toBeInTheDocument()
    const bar = screen.getByTestId("agent-mini-chat-bar")
    expect(bar).toHaveStyle({ width: `${MINI_CHAT_BAR_SIZE.width}px` })
    expect(readMiniChatPlacement(OWNER, { width: 1440, height: 900 }).minimized).toBe(true)

    await user.click(screen.getByTestId("agent-mini-chat-restore"))
    expect(screen.getByTestId("agent-mini-chat")).toHaveStyle({
      width: `${MINI_CHAT_WINDOW_SIZE.width}px`,
    })
    expect(readMiniChatPlacement(OWNER, { width: 1440, height: 900 }).minimized).toBe(false)
  })

  it("drags the collapsed bar without reopening it", () => {
    localStorage.setItem(
      `aq.agent-mini-chat.v1:${OWNER}`,
      JSON.stringify({ x: 300, y: 300, minimized: true }),
    )
    renderMiniChat()
    const bar = screen.getByTestId("agent-mini-chat-bar")
    fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 310, clientY: 310 })
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 410, clientY: 360 })
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 410, clientY: 360 })
    // The pointer-up that ends a drag also fires a click on the bar's button.
    fireEvent.click(screen.getByTestId("agent-mini-chat-restore"))

    expect(screen.getByTestId("agent-mini-chat-bar")).toHaveStyle({ left: "400px", top: "350px" })
    expect(screen.queryByTestId("agent-mini-chat")).not.toBeInTheDocument()
  })

  it("reopens a collapsed window when a new Ask AI question arrives", () => {
    localStorage.setItem(
      `aq.agent-mini-chat.v1:${OWNER}`,
      JSON.stringify({ x: 300, y: 300, minimized: true }),
    )
    const { rerender } = renderMiniChat()
    expect(screen.getByTestId("agent-mini-chat-bar")).toBeInTheDocument()

    rerender(
      <AgentMiniChat
        open
        onClose={vi.fn()}
        onExpand={vi.fn()}
        agent={{ ...AGENT, pendingChip: { kind: "source", text: "ἐν ἀρχῇ" } as never }}
      />,
    )
    expect(screen.getByTestId("agent-mini-chat")).toBeInTheDocument()
  })

  it("hands the current thread to the full chat on expand", async () => {
    const user = userEvent.setup()
    const { props } = renderMiniChat()
    await user.click(screen.getByTestId("agent-mini-chat-expand"))
    expect(props.onExpand).toHaveBeenCalledTimes(1)
    // Expanding is a move, not a restart.
    expect(startNewChat).not.toHaveBeenCalled()
    expect(reset).not.toHaveBeenCalled()
  })

  it("closes the window without ending the conversation", async () => {
    const user = userEvent.setup()
    const { props } = renderMiniChat()
    await user.click(screen.getByTestId("agent-mini-chat-close"))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    // The thread lives on the server and must still be listed afterwards; a
    // reset or a new chat here would quietly throw the conversation away.
    expect(reset).not.toHaveBeenCalled()
    expect(startNewChat).not.toHaveBeenCalled()
    expect(switchTo).not.toHaveBeenCalled()
  })

  it("switches threads from its own chat menu", async () => {
    const user = userEvent.setup()
    renderMiniChat()
    await user.click(screen.getByRole("button", { name: "Chat options" }))
    await user.click(await screen.findByRole("menuitem", { name: "Draft GEN 1" }))
    await vi.waitFor(() => expect(switchTo).toHaveBeenCalledWith("s-old", []), { timeout: STALL_WATCHDOG_MS })
  })

  it("titles the window after the thread on screen", () => {
    renderMiniChat()
    expect(screen.getByTestId("agent-mini-chat-handle")).toHaveTextContent("Why is MRK 4 flagged?")
  })

  it("becomes a bottom sheet below lg, where there is nowhere to drag to", () => {
    isLgUp = false
    renderMiniChat()
    const frame = screen.getByTestId("agent-mini-chat")
    expect(frame.className).toContain("inset-x-0")
    expect(frame.className).toContain("bottom-0")
    expect(frame).not.toHaveAttribute("style", expect.stringContaining("left"))
  })
})
