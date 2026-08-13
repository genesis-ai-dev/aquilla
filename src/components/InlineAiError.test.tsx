// WHY (AQU-891): the editor rendered `errors.get(cellId)` straight into a red
// <p>, so a provider payload landed on every cell of a paragraph draft. This
// is the contract test for the replacement: friendly line inline, verbatim
// text behind the info button, one click to copy it for support.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { InlineAiError } from "./InlineAiError"

const OPENROUTER_413 =
  'Completion failed: 413 {"error":{"message":"request too large for model","code":413}}'

beforeEach(() => {
  // happy-dom's navigator.clipboard is getter-only — define it per AQU-277's
  // ImportDialog.partial-import.test.tsx pattern.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  })
})

describe("InlineAiError", () => {
  it("shows a friendly line and never the raw payload inline", () => {
    render(<InlineAiError message={OPENROUTER_413} />)

    expect(screen.getByRole("alert")).toHaveTextContent("Too much text for this model")
    expect(screen.queryByText(/request too large for model/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Completion failed: 413/)).not.toBeInTheDocument()
  })

  it("reveals the full error text in the popover behind the info button", () => {
    render(<InlineAiError message={OPENROUTER_413} />)

    fireEvent.click(screen.getByRole("button", { name: /show error details/i }))
    expect(screen.getByText(OPENROUTER_413)).toBeInTheDocument()
  })

  it("copies the raw error to the clipboard for support", async () => {
    render(<InlineAiError message={OPENROUTER_413} />)

    fireEvent.click(screen.getByRole("button", { name: /show error details/i }))
    fireEvent.click(screen.getByRole("button", { name: /copy error/i }))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(OPENROUTER_413)
  })

  it("prefixes the operation when a label is given", () => {
    render(<InlineAiError message={OPENROUTER_413} label="Apply failed" />)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Apply failed: Too much text for this model",
    )
  })

  it("renders a plain-language message verbatim, with no extra affordance", () => {
    // Messages we authored are already the right thing to read — the info
    // button would reveal nothing new, so it isn't rendered.
    render(<InlineAiError message="Out of credits." />)
    expect(screen.getByRole("alert")).toHaveTextContent("Out of credits.")
    expect(screen.queryByRole("button", { name: /show error details/i })).not.toBeInTheDocument()
  })

  it("omits role=alert when an ancestor already announces the failure", () => {
    render(<InlineAiError message={OPENROUTER_413} announce={false} />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByText("Too much text for this model")).toBeInTheDocument()
  })
})
