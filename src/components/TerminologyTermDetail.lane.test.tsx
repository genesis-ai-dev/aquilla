// AQU-1902: the term-occurrence inline edit commits to the lane the
// occurrences were read from. It used to send no lane at all, which addresses
// the default lane — a lane projects created today do not have — so the server
// refused the edit and the outbox dropped it.
import { describe, expect, it, vi, beforeEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TerminologyTermDetail } from "./TerminologyTermDetail"
import { buildCellData } from "@/hooks/useCells"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { Concept } from "@/lib/terminology/types"

const emitCommit = vi.fn<(input: Record<string, unknown>) => Promise<string>>()
vi.mock("@/lib/sync/events-emit", () => ({
  emitTargetCellCommit: (input: Record<string, unknown>) => emitCommit(input),
}))

// The real editor is TipTap; a stub that commits on click keeps this test about
// what the row sends, not about the editor.
vi.mock("@/components/TranslatedEditor", () => ({
  TranslatedEditor: ({ onCommit }: { onCommit: (c: { value: string; valueHtml: string }) => void }) => (
    <button type="button" onClick={() => onCommit({ value: "Dios", valueHtml: "<p>Dios</p>" })}>
      commit-stub
    </button>
  ),
}))

const concept: Concept = {
  id: "concept-god",
  sourceTerm: "God",
  renderings: [],
  status: "active",
  createdAt: "2026-10-01T00:00:00Z",
}

function row(side: "source" | "target", value: string, eventId: string, targetLang = ""): CellRow {
  return {
    cellId: "cell-1", side, value, valueHtml: null, type: "text", canonicalRef: "GEN 1:1",
    anchorCellId: null, eventId, sourceEventId: side === "target" ? "evt-src" : null,
    lastEditor: null, lastEditAt: 1, validated: false, wordCount: 1, targetLang,
  }
}

function renderDetail(activeLane?: string) {
  const cell = buildCellData(
    "cell-1",
    row("source", "In the beginning God", "evt-src"),
    row("target", "En el principio", "evt-target", activeLane ?? ""),
    "file-1", "alice", 1, undefined,
  )
  render(
    <TerminologyTermDetail
      concept={concept}
      cells={[cell]}
      canEdit
      projectId="proj-1902"
      {...(activeLane !== undefined ? { activeLane } : {})}
      username="alice"
      onClose={vi.fn()}
      onCellCommitted={vi.fn()}
      onOptimisticEdit={vi.fn()}
    />,
  )
}

describe("TerminologyTermDetail inline edit lane (AQU-1902)", () => {
  beforeEach(() => {
    emitCommit.mockReset()
    emitCommit.mockResolvedValue("evt-new")
  })

  it("commits to the active lane the occurrences came from", async () => {
    renderDetail("Spanish")
    fireEvent.click(screen.getByText("En el principio"))
    fireEvent.click(screen.getByText("commit-stub"))
    await waitFor(() => expect(emitCommit).toHaveBeenCalledTimes(1))
    expect(emitCommit.mock.calls[0]![0]).toMatchObject({
      projectId: "proj-1902",
      fileId: "file-1",
      cellId: "cell-1",
      value: "Dios",
      targetLang: "Spanish",
    })
  })

  it("names the legacy default lane explicitly when that is the open lane", async () => {
    renderDetail()
    fireEvent.click(screen.getByText("En el principio"))
    fireEvent.click(screen.getByText("commit-stub"))
    await waitFor(() => expect(emitCommit).toHaveBeenCalledTimes(1))
    expect(emitCommit.mock.calls[0]![0]).toHaveProperty("targetLang", "")
  })
})
