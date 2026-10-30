// AQU-2260 (Sam, Oct 29): the Human-edited badge says what it means on a
// click, never on hover — hover does nothing on touch, and the protection it
// stands for is the one thing a reviewer must not miss.
import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import type { AgentMemory } from "@/lib/agent/memory-api"
import { ApprovedMemoryList } from "./ApprovedMemoryList"

const memory = (over: Partial<AgentMemory> = {}): AgentMemory => ({
  id: "m1",
  projectId: "p1",
  path: "style/tone.md",
  content: "Keep it plain.",
  status: "approved",
  humanEdited: true,
  rationale: null,
  provenance: null,
  createdBy: "anna",
  reviewedBy: "anna",
  version: 2,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  ...over,
})

describe("ApprovedMemoryList", () => {
  it("opens what Human-edited protects on click, never on hover", async () => {
    renderWithTooltips(
      <ApprovedMemoryList memories={[memory()]} roleLevel={null} username="anna" onEdit={vi.fn(async () => {})} />,
    )
    await expectClickNote(
      screen.getByRole("button", { name: /Human-edited/ }),
      "Protected: the agent cannot modify this; it can only ask.",
    )
  })

  it("draws no badge on a row the agent may still change", () => {
    renderWithTooltips(
      <ApprovedMemoryList memories={[memory({ humanEdited: false })]} roleLevel={null} username="anna" onEdit={vi.fn(async () => {})} />,
    )
    expect(screen.queryByText("Human-edited")).toBeNull()
  })
})
