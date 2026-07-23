/**
 * AgentRunView tests — the run timeline must show the user what the agent
 * DID (tool chips with verdicts + expandable results) IN THE ORDER it did it
 * (chips interleaved with prose, not stacked), what it SAID (markdown), what
 * it COST (usage line), and when it FAILED or got CAPPED — the transparency
 * half of the propose-then-apply trust model.
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
    items: [],
    status: "ok",
    ...overrides,
  }
}

describe("AgentRunView", () => {
  it("renders the prompt, tool chips with verdicts, and expandable result summaries", () => {
    render(
      <AgentRunView
        run={makeRun({
          items: [
            {
              id: "i0",
              kind: "tool",
              step: 1,
              tool: "sql",
              summary: "SELECT cell_id FROM cells WHERE …",
              ok: true,
              resultSummary: "#c1|MRK 4:1|∅\n#c2|MRK 4:2|∅",
            },
            { id: "i1", kind: "tool", step: 2, tool: "emit", summary: "2 events" }, // still running
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

  it("interleaves prose and tool chips in timeline order", () => {
    const { container } = render(
      <AgentRunView
        run={makeRun({
          items: [
            { id: "i0", kind: "text", text: "Reading the chapter first." },
            { id: "i1", kind: "tool", step: 1, tool: "read", summary: "MRK 4 · 32 cells", ok: true },
            { id: "i2", kind: "text", text: "Now drafting." },
          ],
        })}
      />,
    )
    const text = container.textContent ?? ""
    const first = text.indexOf("Reading the chapter first.")
    const chip = text.indexOf("MRK 4 · 32 cells")
    const second = text.indexOf("Now drafting.")
    expect(first).toBeGreaterThan(-1)
    expect(chip).toBeGreaterThan(first)
    expect(second).toBeGreaterThan(chip)
  })

  it("renders proposals inline through the renderProposal seam, in order", () => {
    render(
      <AgentRunView
        run={makeRun({
          items: [
            { id: "i0", kind: "text", text: "Staged the drafts:" },
            {
              id: "i1",
              kind: "proposal",
              proposal: { proposalId: "p1", runId: "run-1", events: [], summary: "Draft 2 cells" },
            },
          ],
        })}
        renderProposal={(p) => <div data-testid="proposal-slot">{p.summary}</div>}
      />,
    )
    expect(screen.getByTestId("proposal-slot")).toHaveTextContent("Draft 2 cells")
  })

  it("renders assistant text as markdown", () => {
    render(
      <AgentRunView
        run={makeRun({
          items: [{ id: "i0", kind: "text", text: "## Findings\n\n- **3 cells** untranslated" }],
        })}
      />,
    )
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument()
    expect(screen.getByText("3 cells")).toBeInTheDocument()
  })

  it("renders the usage line in credits, never raw $", () => {
    render(
      <AgentRunView
        run={makeRun({
          usage: { promptTokens: 12000, completionTokens: 3400, costCredits: 13 },
        })}
      />,
    )
    expect(
      screen.getByText(/12,000 prompt \+ 3,400 completion tokens · 13 cr/),
    ).toBeInTheDocument()
  })

  it("renders error and capped states, and a running indicator with progress", () => {
    const { unmount } = render(
      <AgentRunView run={makeRun({ status: "error", errorMessage: "Out of credits." })} />,
    )
    expect(screen.getByText("Out of credits.")).toBeInTheDocument()
    unmount()

    const second = render(<AgentRunView run={makeRun({ status: "capped" })} />)
    expect(screen.getByText(/hit its step\/token cap/)).toBeInTheDocument()
    second.unmount()

    const third = render(<AgentRunView run={makeRun({ status: "running" })} />)
    expect(screen.getByText("Agent working…")).toBeInTheDocument()
    third.unmount()

    render(
      <AgentRunView
        run={makeRun({ status: "running", progress: { label: "Drafting MRK 4", done: 3, total: 12 } })}
      />,
    )
    expect(screen.getByText("Drafting MRK 4 — 3/12")).toBeInTheDocument()
  })
})
