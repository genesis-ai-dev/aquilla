import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { AgentEmptyState } from "./AgentEmptyState"
import { AGENT_PROMPT_HINTS } from "./prompt-hints"

describe("AgentEmptyState", () => {
  it("keeps the landing state quiet while retaining prompt hints for the composer", () => {
    render(<AgentEmptyState />)

    expect(screen.getByText("What should we work on?")).toBeInTheDocument()
    expect(screen.queryByText("Try asking")).not.toBeInTheDocument()
    expect(screen.queryByText("Shortcuts")).not.toBeInTheDocument()
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(AGENT_PROMPT_HINTS).toHaveLength(4)
  })
})
