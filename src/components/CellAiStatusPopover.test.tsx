import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { CellAiStatusPopover } from "./CellAiStatusPopover"
import type { ActionableError } from "@/lib/audio/ai-error"

const error: ActionableError = {
  category: "provider-unavailable",
  title: "OmniVoice isn't configured",
  body: "This line uses OmniVoice, not Gemini. Hosted TTS isn't wired on this server — a Gemini API key will not fix it.",
  raw: "TTS not configured",
}

describe("CellAiStatusPopover", () => {
  it("renders Dismiss as a text-only button", () => {
    const onDismiss = vi.fn()
    render(
      <CellAiStatusPopover
        trigger={<button type="button">Failed</button>}
        error={error}
        actions={[]}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Failed" }))
    const dismiss = screen.getByRole("button", { name: "Dismiss" })
    expect(dismiss.querySelector("svg")).toBeNull()

    fireEvent.click(dismiss)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
