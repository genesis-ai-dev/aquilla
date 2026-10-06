// AQU-1690: the activity inspector shows the Bible facts each passage of a
// run used — the same lines the construe and draft prompts carried — so a
// reviewer can see why autopilot gave the words to Jesus, not guess.

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { BibleFactsEvidence } from "./BibleFactsEvidence"

const fetchTraces = vi.hoisted(() => vi.fn())
vi.mock("@/lib/contextual/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/contextual/transport")>()),
  fetchContextualRunTraces: fetchTraces,
}))

const factsRow = {
  id: 7,
  spanId: "s1",
  label: "bible-facts",
  tier: "code",
  model: "bkp@1.0.0",
  system: "",
  user: "JHN 4:7: speech Jesus [person:Jesus.2] → Samaritan woman [local:JHN:n43004007002], quote level 1 opens and closes here",
  output: null,
  error: null,
  generationId: null,
  promptTokens: 0,
  completionTokens: 0,
  costCents: 0,
  latencyMs: 0,
  attempts: 1,
  truncated: false,
  createdAt: "2026-10-06T00:00:00Z",
}

describe("BibleFactsEvidence", () => {
  it("loads the run's bible-facts rows when opened, and shows each passage's facts", async () => {
    fetchTraces.mockResolvedValueOnce({ traces: [factsRow], truncated: false })
    render(<BibleFactsEvidence projectId="p1" runId="r1" />)
    expect(fetchTraces).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Bible facts each passage used" }))
    expect(fetchTraces).toHaveBeenCalledWith("p1", "r1", undefined, { label: "bible-facts" })
    expect(await screen.findByText(/JHN 4:7: speech Jesus \[person:Jesus\.2\] → Samaritan woman/)).toBeInTheDocument()
  })

  it("says so when the run used no Bible facts", async () => {
    fetchTraces.mockResolvedValueOnce({ traces: [], truncated: false })
    render(<BibleFactsEvidence projectId="p1" runId="r1" />)
    fireEvent.click(screen.getByRole("button", { name: "Bible facts each passage used" }))
    expect(await screen.findByText("No Bible facts were used in this run.")).toBeInTheDocument()
  })
})
