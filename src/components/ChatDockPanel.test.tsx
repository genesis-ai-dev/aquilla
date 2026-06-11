/**
 * ChatDockPanel.test.tsx — chat UX improvements
 *
 * The dock shell must render assistant markdown, the message actions, and
 * composer/error behavior through the shared chat components
 * (src/components/chat/). This is the panel-level coverage for those pieces.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ChatDockPanel } from "./ChatDockPanel"
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

describe("ChatDockPanel", () => {
  it("renders assistant markdown and message actions", () => {
    render(<ChatDockPanel chat={makeChat()} currentCell={CELL} onInsertIntoCell={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument()
    expect(screen.getByText("bold")).toBeInTheDocument()
    expect(screen.getByText("code line")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Insert into cell" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument()
  })

  it("hides Insert into cell when no cell is focused", () => {
    render(<ChatDockPanel chat={makeChat()} currentCell={null} onInsertIntoCell={vi.fn()} />)
    expect(screen.queryByRole("button", { name: "Insert into cell" })).not.toBeInTheDocument()
  })

  it("sends on Enter and newlines on Shift+Enter", () => {
    const chat = makeChat()
    render(<ChatDockPanel chat={chat} currentCell={null} />)
    const ta = screen.getByPlaceholderText(/Ask a question/)
    fireEvent.change(ta, { target: { value: "hello" } })
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true })
    expect(chat.sendMessage).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(chat.sendMessage).toHaveBeenCalledWith("hello", null)
  })

  it("shows failed messages with Retry and Dismiss", () => {
    const failed: UiChatMessage = {
      id: "f1",
      role: "user",
      content: "lost message",
      ts: Date.now(),
      status: "failed",
      errorMessage: "Connection lost — retry?",
      errorDetail: "Failed to fetch",
    }
    const chat = makeChat({ messages: [failed] })
    render(<ChatDockPanel chat={chat} currentCell={null} />)
    expect(screen.getByText("lost message")).toBeInTheDocument()
    expect(screen.getByText("Connection lost — retry?")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }))
    expect(chat.retryMessage).toHaveBeenCalledWith("f1", null)
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }))
    expect(chat.dismissMessage).toHaveBeenCalledWith("f1")
  })
})
