// Revision attribution — WHY: the "by <author>" line sits in a block of muted
// metadata (badges, timestamps, markers). The name is the only part a reviewer
// scans for, which is why it carries font-medium; keying the line as a single
// catalog string dropped that weight and left the name indistinguishable from
// the chrome around it.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { HistoryDrawer } from "./HistoryDrawer"
import type { CellData } from "@/hooks/useCells"
import type { CellHistoryEntry } from "@/lib/parsers/types"

vi.mock("@/hooks/useCellEditHistory", () => ({
  useCellEditHistory: vi.fn(),
}))

import { useCellEditHistory } from "@/hooks/useCellEditHistory"

const mockHook = vi.mocked(useCellEditHistory)

const entry: CellHistoryEntry = {
  timestamp: "2026-07-01T10:00:00.000Z",
  value: "an older translation",
  source: "human",
  author: "ana",
  validated: false,
}

function makeCell(history: CellHistoryEntry[] = []): CellData {
  return {
    id: "c1",
    fileId: "f1",
    original: "source text",
    translated: "target text",
    context: "GEN 1:1",
    history,
  } as CellData
}

beforeEach(() => vi.clearAllMocks())

describe("HistoryDrawer revision attribution", () => {
  it("keeps the author name emphasised inside the translated attribution line", () => {
    mockHook.mockReturnValue({
      history: [entry],
      isLoading: false,
      isError: false,
      revalidate: vi.fn(),
    })
    render(
      <HistoryDrawer
        cell={makeCell()}
        onClose={vi.fn()}
        projectId="p1"
        fileId="f1"
        getTokenForFile={async () => null}
        isSynced
      />,
    )

    // Assert the element and its class, not the text: "by ana" reads the same
    // whether or not the name is styled, so a text assertion cannot fail on the
    // flattened version.
    const name = screen.getByText("ana")
    expect(name.tagName).toBe("SPAN")
    expect(name).toHaveClass("font-medium")
    // The word before it comes from the same translated sentence, so the
    // translator still controls where the name goes.
    expect(name.parentElement?.textContent).toContain("by ana")
  })
})
