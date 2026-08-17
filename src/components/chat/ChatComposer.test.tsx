import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { createRef } from "react"
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer"

describe("ChatComposer (TipTap)", () => {
  it("uses Enter for a newline and Command+Enter to send", () => {
    const onSend = vi.fn()
    const ref = createRef<ChatComposerHandle>()
    render(<ChatComposer ref={ref} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    ref.current!.insertText("First line")
    const textbox = screen.getByRole("textbox")
    fireEvent.keyDown(textbox, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("insertChip adds a chip that serializes into the send payload on Command+Enter", () => {
    const onSend = vi.fn()
    const ref = createRef<ChatComposerHandle>()
    render(<ChatComposer ref={ref} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    ref.current!.insertChip({
      chipId: "a", fileId: "f", cellId: "z", canonicalRef: "GEN 1:1",
      side: "source", selection: "In the beginning", preview: "In the beginning",
    })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true })
    expect(onSend).toHaveBeenCalledTimes(1)
    const payload = onSend.mock.calls[0][0]
    expect(payload.chips).toHaveLength(1)
    expect(payload.text).toContain("⟦chip:a⟧")
  })

  it("shows Stop and calls onStop while streaming", () => {
    const onStop = vi.fn()
    render(<ChatComposer isStreaming isConfigured onSend={vi.fn()} onStop={onStop} />)
    fireEvent.click(screen.getByRole("button", { name: /stop/i }))
    expect(onStop).toHaveBeenCalled()
  })

  it("keeps keyboard shortcuts functional without permanent help copy", () => {
    render(<ChatComposer isStreaming={false} isConfigured onSend={vi.fn()} onStop={vi.fn()} />)
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toHaveClass("min-h-10", "max-h-32", "overflow-y-auto")
  })
})
