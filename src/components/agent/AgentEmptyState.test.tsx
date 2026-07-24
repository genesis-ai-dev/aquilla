/**
 * AgentEmptyState tests — the first-run guide teaches by example (prompt
 * chips prefill, never send), stays dismissable, and keeps the user guide
 * reachable after dismissal so docs aren't a one-shot discovery.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AgentEmptyState, AGENT_GUIDE_URL, EXAMPLE_PROMPTS } from "./AgentEmptyState"

beforeEach(() => {
  localStorage.clear()
})

describe("AgentEmptyState", () => {
  it("shows intro, example prompts, slash commands, and the guide link", () => {
    render(<AgentEmptyState onPromptSelect={() => {}} />)
    expect(screen.getByText(/works inside this project/)).toBeInTheDocument()
    for (const prompt of EXAMPLE_PROMPTS) {
      expect(screen.getByRole("button", { name: prompt })).toBeInTheDocument()
    }
    for (const cmd of ["/draft", "/check", "/find", "/status"]) {
      expect(screen.getByText(cmd)).toBeInTheDocument()
    }
    expect(screen.getByRole("link", { name: /User guide/ })).toHaveAttribute(
      "href",
      AGENT_GUIDE_URL,
    )
  })

  it("prefills (not sends): clicking a prompt passes its text to onPromptSelect", () => {
    const onPromptSelect = vi.fn()
    render(<AgentEmptyState onPromptSelect={onPromptSelect} />)
    fireEvent.click(screen.getByRole("button", { name: EXAMPLE_PROMPTS[0] }))
    expect(onPromptSelect).toHaveBeenCalledWith(EXAMPLE_PROMPTS[0])
  })

  it("dismiss persists and falls back to the minimal state with a guide link", () => {
    render(<AgentEmptyState onPromptSelect={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /Don't show this again/ }))

    // Guide gone, minimal one-liner + docs link remain.
    expect(screen.queryByText(/Try asking/)).toBeNull()
    expect(screen.getByText(/draft, check, or explain/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /User guide/ })).toHaveAttribute(
      "href",
      AGENT_GUIDE_URL,
    )

    // A fresh mount respects the persisted flag.
    const second = render(<AgentEmptyState onPromptSelect={() => {}} />)
    expect(second.queryByText(/Try asking/)).toBeNull()
  })
})
