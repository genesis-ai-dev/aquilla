// AQU-1321 — per-cell post-editing distance in the Edit History drawer.
//
// WHY at this level: the derivation is unit-tested in
// `src/lib/metrics/history-post-edit.test.ts`. What those tests cannot see is
// whether the reading reaches the card the reader is looking at. The drawer
// collapses keystroke runs and renders only each group's terminal entry, so a
// correct number attached to the wrong index is invisible on screen while every
// unit test still passes — that composition is what this file covers.
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

let clock = Date.parse("2026-09-01T10:00:00.000Z")

function entry(
  source: "human" | "llm",
  value: string,
  extra: Partial<CellHistoryEntry> = {},
): CellHistoryEntry {
  clock += 1000
  return {
    timestamp: new Date(clock).toISOString(),
    value,
    source,
    author: source === "llm" ? "autopilot" : "ana",
    validated: false,
    eventId: `e${clock}`,
    ...extra,
  }
}

function makeCell(): CellData {
  return {
    id: "c1",
    fileId: "f1",
    original: "source text",
    translated: "target text",
    context: "GEN 1:1",
    history: [],
  } as unknown as CellData
}

function renderWith(history: CellHistoryEntry[]) {
  mockHook.mockReturnValue({
    history,
    isLoading: false,
    isError: false,
    revalidate: vi.fn(),
  })
  return render(
    <HistoryDrawer
      cell={makeCell()}
      onClose={vi.fn()}
      projectId="p1"
      fileId="f1"
      getTokenForFile={async () => null}
      isSynced
    />,
  )
}

beforeEach(() => vi.clearAllMocks())

describe("HistoryDrawer — post-editing distance", () => {
  it("states how much of the AI draft the revision kept", () => {
    renderWith([entry("llm", "abcdefghij"), entry("human", "abcdefghXY")])
    expect(screen.getByText("80% of AI draft kept")).toBeInTheDocument()
  })

  it("shows the badge on the visible card of a collapsed keystroke run", () => {
    // These three human edits group into one card whose terminal is the LAST of
    // them. Before the fix the reading had nowhere to land that the reader could
    // see; this asserts it is on the rendered card and not in the collapsed tail.
    renderWith([
      entry("llm", "abcdefghij"),
      entry("human", "abcdefghi"),
      entry("human", "abcdefgh"),
      entry("human", "abcdefghXY"),
    ])

    const badge = screen.getByText("80% of AI draft kept")
    expect(badge).toBeInTheDocument()
    // The intermediate edits are still collapsed, which is what makes the
    // placement load-bearing rather than incidental.
    expect(screen.getByText("+2 minor edits")).toBeInTheDocument()
    // The badge sits in the same card as the collapse hint, i.e. the terminal.
    expect(badge.closest("li")).toBe(screen.getByText("+2 minor edits").closest("li"))
  })

  it("says the draft was kept as-is when it was approved unchanged", () => {
    renderWith([entry("llm", "good enough", { validated: true })])
    expect(screen.getByText("AI draft kept as-is")).toBeInTheDocument()
    expect(screen.queryByText(/of AI draft kept/)).not.toBeInTheDocument()
  })

  it("shows nothing for a cell that was never AI-drafted", () => {
    // AC: human-authored cells are excluded. A "0% kept" badge here would be a
    // damning-looking number about a draft that never existed.
    renderWith([entry("human", "typed"), entry("human", "typed out", { validated: true })])
    expect(screen.queryByText(/AI draft kept/)).not.toBeInTheDocument()
  })

  it("shows nothing on a stale branch that lost its slot", () => {
    // The same card already carries a "stale branch" badge saying this edit was
    // never applied; a survival percentage beside it would contradict that.
    renderWith([
      entry("llm", "abcdefghij"),
      entry("human", "totally different text", { isStale: true }),
    ])
    expect(screen.getByText("stale branch")).toBeInTheDocument()
    expect(screen.queryByText(/AI draft kept/)).not.toBeInTheDocument()
  })
})
