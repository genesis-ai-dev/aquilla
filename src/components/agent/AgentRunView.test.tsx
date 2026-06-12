/**
 * AgentRunView tests — the run timeline must show the user what the agent
 * DID (steps with verdicts + expandable results), what it SAID (markdown),
 * what it COST (usage line), and when it FAILED or got CAPPED — the
 * transparency half of the propose-then-apply trust model.
 */

import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { AgentRunUi } from "@/lib/agent/run-state"
import { AgentRunView } from "./AgentRunView"

function makeRun(overrides: Partial<AgentRunUi> = {}): AgentRunUi {
  return {
    localId: "run-local-1",
    prompt: "Draft the untranslated verses in this chapter",
    runId: "run-1",
    assistantText: "",
    steps: [],
    proposals: [],
    status: "ok",
    ...overrides,
  }
}

describe("AgentRunView", () => {
  it("renders the prompt, steps with verdicts, and expandable result summaries", () => {
    render(
      <AgentRunView
        run={makeRun({
          steps: [
            {
              step: 1,
              kind: "sql",
              summary: "SELECT cell_id FROM cells WHERE …",
              ok: true,
              resultSummary: "#c1|MRK 4:1|∅\n#c2|MRK 4:2|∅",
            },
            { step: 2, kind: "emit", summary: "2 events" }, // still running
          ],
        })}
      />,
    )
    expect(screen.getByText("Draft the untranslated verses in this chapter")).toBeInTheDocument()
    expect(screen.getByText("SELECT cell_id FROM cells WHERE …")).toBeInTheDocument()
    expect(screen.getByLabelText("Step succeeded")).toBeInTheDocument()
    expect(screen.getByLabelText("Step running")).toBeInTheDocument()

    // Result block is collapsed until the row is expanded.
    expect(screen.queryByText(/#c1\|MRK 4:1/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("SELECT cell_id FROM cells WHERE …"))
    expect(screen.getByText(/#c1\|MRK 4:1/)).toBeInTheDocument()
  })

  it("renders assistant text as markdown", () => {
    render(
      <AgentRunView
        run={makeRun({ assistantText: "## Findings\n\n- **3 cells** untranslated" })}
      />,
    )
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument()
    expect(screen.getByText("3 cells")).toBeInTheDocument()
  })

  it("renders the usage/cost line", () => {
    render(
      <AgentRunView
        run={makeRun({
          usage: { promptTokens: 12000, completionTokens: 3400, costCents: 2.5 },
        })}
      />,
    )
    expect(
      screen.getByText(/12,000 prompt \+ 3,400 completion tokens · \$0\.0250/),
    ).toBeInTheDocument()
  })

  it("renders error and capped states, and a running indicator", () => {
    const { unmount } = render(
      <AgentRunView run={makeRun({ status: "error", errorMessage: "Out of credits." })} />,
    )
    expect(screen.getByText("Out of credits.")).toBeInTheDocument()
    unmount()

    const second = render(<AgentRunView run={makeRun({ status: "capped" })} />)
    expect(screen.getByText(/hit its step\/token cap/)).toBeInTheDocument()
    second.unmount()

    render(<AgentRunView run={makeRun({ status: "running" })} />)
    expect(screen.getByText("Agent working…")).toBeInTheDocument()
  })
})
