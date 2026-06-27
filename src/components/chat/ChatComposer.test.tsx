import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { createRef } from "react"
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer"

describe("ChatComposer (TipTap)", () => {
  it("does not send an empty editor on Enter", () => {
    const onSend = vi.fn()
    render(<ChatComposer isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("insertChip adds a chip that serializes into the send payload on Enter", () => {
    const onSend = vi.fn()
    const ref = createRef<ChatComposerHandle>()
    render(<ChatComposer ref={ref} isStreaming={false} isConfigured onSend={onSend} onStop={vi.fn()} />)
    ref.current!.insertChip({
      chipId: "a", fileId: "f", cellId: "z", canonicalRef: "GEN 1:1",
      side: "source", selection: "In the beginning", preview: "In the beginning",
    })
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" })
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
})
