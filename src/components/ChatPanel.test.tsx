/**
 * ChatPanel.test.tsx — chat UX improvements
 *
 * The Sheet chat shell must render assistant markdown and the message actions
 * through the shared chat components. The Sheet variant has no UI entry point
 * on main right now (the left dock hosts the AI agent, not chat), so this test
 * is its only coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ChatPanel } from "./ChatPanel"
import type { UseChatReturn, UiChatMessage, CellContext } from "@/hooks/useChat"

const MD_REPLY = "## Notes\n\n- **bold** point\n\n```text\ncode line\n```"

function makeChat(overrides: Partial<UseChatReturn> = {}): UseChatReturn {
  const messages: UiChatMessage[] = [
    { id: "u1", role: "user", content: "Question?", ts: Date.now() },
    { id: "a1", role: "assistant", content: MD_REPLY, ts: Date.now() },
  ]
  return {
    messages,
    streamingText: "",
    isStreaming: false,
    includeCellContext: true,
    setIncludeCellContext: vi.fn(),
    isConfigured: true,
    sendMessage: vi.fn(),
    retryMessage: vi.fn(),
    dismissMessage: vi.fn(),
    regenerate: vi.fn(),
    stopStreaming: vi.fn(),
    clearHistory: vi.fn(),
    ...overrides,
  }
}

const CELL: CellContext = { sourceText: "src", translatedText: "", context: "GEN 1:1" }

beforeEach(() => {
  // jsdom lacks scrollTo on elements.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn(), writable: true })
})

describe("ChatPanel (sheet)", () => {
  it("renders assistant markdown and message actions", () => {
    render(
      <ChatPanel
        open
        onOpenChange={vi.fn()}
        chat={makeChat()}
        currentCell={CELL}
        onInsertIntoCell={vi.fn()}
      />,
    )
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument()
    expect(screen.getByText("bold")).toBeInTheDocument()
    expect(screen.getByText("code line")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Insert into cell" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument()
  })

  it("hides Insert into cell when no cell is focused", () => {
    render(
      <ChatPanel
        open
        onOpenChange={vi.fn()}
        chat={makeChat()}
        currentCell={null}
        onInsertIntoCell={vi.fn()}
      />,
    )
    expect(screen.queryByRole("button", { name: "Insert into cell" })).not.toBeInTheDocument()
  })

  it("sends on Enter and newlines on Shift+Enter", () => {
    const chat = makeChat()
    render(<ChatPanel open onOpenChange={vi.fn()} chat={chat} currentCell={null} />)
    const ta = screen.getByPlaceholderText(/Ask a question/)
    fireEvent.change(ta, { target: { value: "hello" } })
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true })
    expect(chat.sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(chat.sendMessage).toHaveBeenCalledWith("hello", null)
  })
})
