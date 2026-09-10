import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { PlanBoard } from "./PlanBoard"
import type { PlanUnit } from "@/lib/plan/plan-status"

const NOW = Date.parse("2026-09-02T09:00:00Z")

function unit(over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    fileId: "f1", fileName: "Mark", sectionKey: "",
    totalCount: 100, filledCount: 0, validatedCount: 0,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null,
    ...over,
  } as PlanUnit
}

function renderBoard(units: PlanUnit[], selectedId: string | null = null) {
  const onSelect = vi.fn()
  render(<PlanBoard units={units} now={NOW} projectId="p1" selectedId={selectedId} onSelect={onSelect} />)
  return { onSelect }
}

describe("grouping", () => {
  it("orders groups by urgency, with Done last", () => {
    renderBoard([
      unit({ fileId: "a", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "b", targetDate: "2026-08-01" }),
      unit({ fileId: "c", filledCount: 5 }),
      unit({ fileId: "d" }),
    ])
    const groups = screen.getAllByTestId(/^plan-group-/).map((el) => el.getAttribute("data-testid"))
    expect(groups).toEqual([
      "plan-group-overdue",
      "plan-group-in_progress",
      "plan-group-not_started",
      "plan-group-done",
    ])
  })

  it("hides empty groups so a healthy project reads short", () => {
    renderBoard([unit({ filledCount: 3 })])
    expect(screen.getByTestId("plan-group-in_progress")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-group-overdue")).toBeNull()
    expect(screen.queryByTestId("plan-group-done")).toBeNull()
  })

  it("counts the rows in each group header", () => {
    renderBoard([unit({ fileId: "a" }), unit({ fileId: "b" }), unit({ fileId: "c", filledCount: 1 })])
    expect(within(screen.getByTestId("plan-group-not_started")).getByText("2")).toBeInTheDocument()
  })

  it("puts the soonest target first within a group", () => {
    renderBoard([
      unit({ fileId: "late", fileName: "Later", targetDate: "2026-12-01", filledCount: 1 }),
      unit({ fileId: "soonish", fileName: "Sooner", targetDate: "2026-10-01", filledCount: 1 }),
    ])
    // Rows specifically — the group header is itself a button now (it folds),
    // so a bare getAllByRole("button") would hand back the header first.
    const rows = within(screen.getByTestId("plan-group-in_progress")).getAllByTestId(/^plan-row-/)
    expect(rows[0]).toHaveTextContent("Sooner")
  })
})

describe("summary", () => {
  it("reports done out of total and flags overdue", () => {
    renderBoard([
      unit({ fileId: "a", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "b", targetDate: "2026-08-01" }),
      unit({ fileId: "c" }),
    ])
    expect(screen.getByTestId("plan-summary")).toHaveTextContent("1 of 3 done")
    expect(screen.getByTestId("plan-summary-overdue")).toHaveTextContent("1 overdue")
  })

  it("shows no overdue badge when everything is on time", () => {
    renderBoard([unit({ filledCount: 1 })])
    expect(screen.queryByTestId("plan-summary-overdue")).toBeNull()
  })
})

describe("the date column", () => {
  it("shows a unit's target date, which is the reason the board exists", () => {
    renderBoard([unit({ targetDate: "2026-11-01", filledCount: 5 })])
    // Uses the app's own deadline formatting, which drops the year in-year.
    expect(screen.getByTestId("plan-date-f1-")).toHaveTextContent("November 1")
  })

  it("shows a dash when nothing is planned yet", () => {
    renderBoard([unit({ filledCount: 5 })])
    expect(screen.getByTestId("plan-date-f1-")).toHaveTextContent("—")
  })

  it("says how late an overdue unit is", () => {
    // The date alone does not answer "how bad is this".
    renderBoard([unit({ targetDate: "2026-08-01" })])
    expect(screen.getByText(/days late/)).toBeInTheDocument()
  })

  it("says when a done unit was marked, rather than how stale it is", () => {
    renderBoard([unit({ doneAt: Date.parse("2026-08-20T00:00:00Z"), doneBy: "r" })])
    // Scoped to the row: the Done group header also contains the word "marked".
    const row = screen.getByTestId("plan-row-f1-")
    expect(within(row).getByText(/^marked /)).toBeInTheDocument()
  })

  it("does not repeat the group's status on every row", () => {
    // The group header already says it; thirty-one identical chips are noise.
    renderBoard([unit({ filledCount: 5 }), unit({ fileId: "b", filledCount: 5 })])
    const rows = screen.getAllByTestId(/^plan-row-f1-|^plan-row-b-/)
    for (const r of rows) expect(r.textContent).not.toMatch(/In progress/)
    expect(within(screen.getByTestId("plan-group-in_progress")).getByText("In progress")).toBeInTheDocument()
  })
})

describe("audio columns", () => {
  it("hides audio bars entirely on a text-only project", () => {
    renderBoard([unit({ filledCount: 50 })])
    expect(screen.queryByLabelText(/^Audio/)).toBeNull()
    expect(screen.queryByText("AUD")).toBeNull()
  })

  it("shows them as soon as one unit has a recording", () => {
    renderBoard([unit({ filledCount: 50, audioCount: 20, audioValidatedCount: 5 })])
    expect(screen.getByLabelText(/^Audio/)).toBeInTheDocument()
    // Labelled, so "20/5%" is not a riddle.
    expect(screen.getByText("AUD")).toBeInTheDocument()
    expect(screen.getByText("TXT")).toBeInTheDocument()
  })
})

describe("selection and keyboard", () => {
  it("reports the clicked unit by file and section", () => {
    const { onSelect } = renderBoard([unit({ sectionKey: "GEN" })])
    fireEvent.click(screen.getByTestId("plan-row-f1-GEN"))
    expect(onSelect).toHaveBeenCalledWith("f1:GEN")
  })

  it("marks the selected row so the inspector's subject is obvious", () => {
    renderBoard([unit({ sectionKey: "GEN" })], "f1:GEN")
    expect(screen.getByTestId("plan-row-f1-GEN")).toHaveAttribute("data-selected", "true")
  })

  it("walks down across a group boundary with the arrow keys", () => {
    // The point of arrow stepping: set a date, arrow down, set the next —
    // without the grouping getting in the way.
    const { onSelect } = renderBoard(
      [unit({ fileId: "a", targetDate: "2026-08-01" }), unit({ fileId: "b" })],
      "a:",
    )
    fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowDown" })
    expect(onSelect).toHaveBeenCalledWith("b:")
  })

  it("walks back up", () => {
    const { onSelect } = renderBoard(
      [unit({ fileId: "a", targetDate: "2026-08-01" }), unit({ fileId: "b" })],
      "b:",
    )
    fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowUp" })
    expect(onSelect).toHaveBeenCalledWith("a:")
  })

  it("stops at the ends rather than wrapping", () => {
    const { onSelect } = renderBoard([unit({ fileId: "a" }), unit({ fileId: "b" })], "a:")
    fireEvent.keyDown(screen.getByRole("region"), { key: "ArrowUp" })
    expect(onSelect).toHaveBeenCalledWith("a:")
  })

  it("closes the inspector on Escape", () => {
    const { onSelect } = renderBoard([unit()], "f1:")
    fireEvent.keyDown(screen.getByRole("region"), { key: "Escape" })
    expect(onSelect).toHaveBeenCalledWith(null)
  })
})

describe("empty state", () => {
  it("explains what a row will be, in language that fits any project", () => {
    renderBoard([])
    const empty = screen.getByTestId("plan-empty")
    expect(empty).toBeInTheDocument()
    expect(empty.textContent).toMatch(/episodes or documents/)
  })
})

describe("the row note versus the inspector note", () => {
  it("shows last activity, not 'no target date', when the date column already says it", () => {
    // The date cell renders an em dash for an undated unit. Repeating the fact
    // in words below it cost a 66-row board its only per-row varying signal.
    const editedAt = Date.parse("2026-09-02T08:00:00Z")
    renderBoard([
      unit({ fileId: "a", fileName: "Numbers", filledCount: 40, lastEditAt: editedAt }),
    ])
    const row = screen.getByTestId("plan-row-a-")
    expect(row).not.toHaveTextContent("no target date")
    expect(row).toHaveTextContent(/hour|minute/)
  })

  it("still spells out how late an overdue unit is", () => {
    renderBoard([
      unit({ fileId: "b", fileName: "Exodus", filledCount: 40, targetDate: "2026-08-10" }),
    ])
    expect(screen.getByTestId("plan-row-b-")).toHaveTextContent("23 days late")
  })
})

// ── AQU-1096: the list controls ──────────────────────────────────────────────

const BOOKS = [
  unit({ fileId: "b", sectionKey: "GEN", fileName: "Bible.usfm", filledCount: 40 }),
  unit({ fileId: "b", sectionKey: "EXO", fileName: "Bible.usfm", filledCount: 40, targetDate: "2026-08-10" }),
  unit({ fileId: "b", sectionKey: "LEV", fileName: "Bible.usfm", doneAt: NOW, doneBy: "randall" }),
]
const rowCount = () => screen.queryAllByTestId(/^plan-row-/).length

beforeEach(() => localStorage.clear())

describe("filtering by name", () => {
  it("narrows to the matching unit and drops the groups it emptied", () => {
    renderBoard(BOOKS)
    expect(rowCount()).toBe(3)
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "genesis" } })
    expect(rowCount()).toBe(1)
    expect(screen.getByTestId("plan-row-b-GEN")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-group-done")).toBeNull()
  })

  it("matches the book code too", () => {
    renderBoard(BOOKS)
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "exo" } })
    expect(screen.getByTestId("plan-row-b-EXO")).toBeInTheDocument()
    expect(rowCount()).toBe(1)
  })

  it("restores every row when cleared", () => {
    renderBoard(BOOKS)
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "genesis" } })
    fireEvent.click(screen.getByTestId("plan-filter-clear"))
    expect(rowCount()).toBe(3)
    expect(screen.queryByTestId("plan-filter-clear")).toBeNull()
  })

  it("shows the filter-miss state, NOT the nothing-to-plan-yet one", () => {
    // Two different problems with two different ways out: one is answered by
    // clearing a filter, the other by importing a source.
    renderBoard(BOOKS)
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "zzz" } })
    expect(screen.getByTestId("plan-no-match")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-empty")).toBeNull()
    fireEvent.click(screen.getByTestId("plan-clear-filters"))
    expect(rowCount()).toBe(3)
  })

  it("KEEPS THE SUMMARY PROJECT-WIDE while filtered", () => {
    // The load-bearing invariant. "1 of 1 done" under a filter that hid the
    // other two would be a lie, and the strip is the one thing on this card a
    // reader trusts without checking.
    renderBoard(BOOKS)
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "genesis" } })
    expect(screen.getByTestId("plan-summary")).toHaveTextContent("1 of 3 done")
    expect(screen.getByTestId("plan-filter-note")).toHaveTextContent("Showing 1 of 3.")
  })
})

describe("needs a date", () => {
  it("shows only units nobody has dated, and never a finished one", () => {
    renderBoard(BOOKS)
    fireEvent.click(screen.getByTestId("plan-needs-date"))
    // GEN has no date; EXO has one; LEV is done, so it needs no date.
    expect(screen.getByTestId("plan-row-b-GEN")).toBeInTheDocument()
    expect(rowCount()).toBe(1)
    expect(screen.getByTestId("plan-needs-date")).toHaveAttribute("aria-pressed", "true")
  })

  it("toggles back off", () => {
    renderBoard(BOOKS)
    fireEvent.click(screen.getByTestId("plan-needs-date"))
    fireEvent.click(screen.getByTestId("plan-needs-date"))
    expect(rowCount()).toBe(3)
  })
})

describe("the Status / Order arrangement", () => {
  it("drops the group headers and puts a status pill on every row", () => {
    renderBoard(BOOKS)
    expect(screen.queryByTestId("plan-order-list")).toBeNull()
    fireEvent.click(screen.getByTestId("plan-view-order"))
    expect(screen.getByTestId("plan-order-list")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-group-done")).toBeNull()
    // Every row now carries its own status, since no header does.
    expect(screen.getAllByTestId(/^plan-status-/).length).toBe(3)
    expect(rowCount()).toBe(3)
  })

  it("keeps the order the server sent, which is canonical", () => {
    renderBoard(BOOKS)
    fireEvent.click(screen.getByTestId("plan-view-order"))
    const rows = within(screen.getByTestId("plan-order-list")).getAllByTestId(/^plan-row-/)
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "plan-row-b-GEN", "plan-row-b-EXO", "plan-row-b-LEV",
    ])
  })

  it("persists globally, so it survives a remount", () => {
    const { unmount } = render(
      <PlanBoard units={BOOKS} now={NOW} projectId="p1" selectedId={null} onSelect={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId("plan-view-order"))
    unmount()
    render(<PlanBoard units={BOOKS} now={NOW} projectId="OTHER" selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByTestId("plan-order-list")).toBeInTheDocument()
  })
})

describe("folding a group away", () => {
  it("hides its rows but keeps its header and count", () => {
    renderBoard(BOOKS)
    expect(rowCount()).toBe(3)
    fireEvent.click(screen.getByTestId("plan-fold-done"))
    expect(rowCount()).toBe(2)
    expect(screen.getByTestId("plan-group-done")).toHaveTextContent("Done")
    expect(screen.getByTestId("plan-fold-done")).toHaveAttribute("aria-expanded", "false")
  })

  it("leaves the summary alone — a fold hides rows, it does not change facts", () => {
    renderBoard(BOOKS)
    fireEvent.click(screen.getByTestId("plan-fold-done"))
    expect(screen.getByTestId("plan-summary")).toHaveTextContent("1 of 3 done")
  })

  it("is scoped to the project, so another project's folds are its own", () => {
    const { unmount } = render(
      <PlanBoard units={BOOKS} now={NOW} projectId="p1" selectedId={null} onSelect={vi.fn()} />,
    )
    fireEvent.click(screen.getByTestId("plan-fold-done"))
    expect(rowCount()).toBe(2)
    unmount()
    render(<PlanBoard units={BOOKS} now={NOW} projectId="p2" selectedId={null} onSelect={vi.fn()} />)
    expect(rowCount()).toBe(3)
  })
})

describe("arrow keys walk only what is on screen", () => {
  const region = () => screen.getByRole("region", { name: /Planning units/ })

  it("skips a row the filter hid", () => {
    const { onSelect } = renderBoard(BOOKS)
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "genesis" } })
    fireEvent.keyDown(region(), { key: "ArrowDown" })
    // Only Genesis is visible, so stepping cannot land on Exodus or Leviticus.
    expect(onSelect).toHaveBeenCalledWith("b:GEN")
  })

  it("clamps at the last VISIBLE row rather than stepping into a fold", () => {
    // Visible order is Overdue (Exodus) then In progress (Genesis) then Done
    // (Leviticus). Fold Done and Genesis becomes the last row on screen, so
    // ArrowDown from it must stay put instead of moving the inspector to
    // Leviticus, which nobody can see.
    const onSelect = vi.fn()
    render(
      <PlanBoard units={BOOKS} now={NOW} projectId="p1" selectedId="b:GEN" onSelect={onSelect} />,
    )
    fireEvent.keyDown(region(), { key: "ArrowDown" })
    expect(onSelect).toHaveBeenLastCalledWith("b:LEV")  // unfolded: steps into Done

    fireEvent.click(screen.getByTestId("plan-fold-done"))
    fireEvent.keyDown(region(), { key: "ArrowDown" })
    expect(onSelect).toHaveBeenLastCalledWith("b:GEN")  // folded: clamps
  })
})

describe("read state is not confused with an empty project", () => {
  it("says it is loading rather than claiming there is nothing to plan", () => {
    render(<PlanBoard units={[]} now={NOW} projectId="p1" status="loading"
      selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByTestId("plan-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-empty")).toBeNull()
  })

  it("offers a retry on failure, not an import", () => {
    // The bug this pins: a 500 told a PM with 66 books that their project was
    // empty, and offered to import a source they already have.
    const onRetry = vi.fn()
    render(<PlanBoard units={[]} now={NOW} projectId="p1" status="error"
      onRetry={onRetry} selectedId={null} onSelect={vi.fn()}
      emptyAction={<button type="button">Import source</button>} />)
    expect(screen.getByTestId("plan-error")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-empty")).toBeNull()
    expect(screen.queryByText("Import source")).toBeNull()
    fireEvent.click(screen.getByTestId("plan-retry"))
    expect(onRetry).toHaveBeenCalled()
  })

  it("shows the empty state only once the read has actually succeeded", () => {
    render(<PlanBoard units={[]} now={NOW} projectId="p1" status="ready"
      selectedId={null} onSelect={vi.fn()} />)
    expect(screen.getByTestId("plan-empty")).toBeInTheDocument()
  })
})

describe("keyboard navigation", () => {
  const region = () => screen.getByRole("region", { name: /Planning units/ })

  it("selects the FIRST row from a cold start, not the second", () => {
    const { onSelect } = renderBoard(BOOKS)
    fireEvent.keyDown(region(), { key: "ArrowDown" })
    // -1 used to be treated as index 0, so ArrowDown skipped a row while
    // ArrowUp correctly landed on the first.
    expect(onSelect).toHaveBeenLastCalledWith("b:EXO")
  })

  it("moves the focus ring with the selection", () => {
    // Without this the ring stays where the reader tabbed, Enter re-selects the
    // row behind them, and a screen reader is told nothing at all.
    render(<PlanBoard units={BOOKS} now={NOW} projectId="p1" selectedId="b:EXO" onSelect={vi.fn()} />)
    fireEvent.keyDown(region(), { key: "ArrowDown" })
    expect(document.activeElement).toHaveAttribute("data-plan-unit", "b:GEN")
  })
})

describe("the order ref the inspector navigates by", () => {
  it("reports exactly the rows on screen, in drawn order", () => {
    const orderRef = { current: [] as PlanUnit[] }
    const { rerender } = render(
      <PlanBoard units={BOOKS} now={NOW} projectId="p1" orderRef={orderRef}
        selectedId={null} onSelect={vi.fn()} />,
    )
    expect(orderRef.current.map((u) => u.sectionKey)).toEqual(["EXO", "GEN", "LEV"])

    // Filtering must narrow it, or the inspector's chevrons step onto rows
    // that are not rendered.
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "genesis" } })
    expect(orderRef.current.map((u) => u.sectionKey)).toEqual(["GEN"])

    fireEvent.click(screen.getByTestId("plan-filter-clear"))
    fireEvent.click(screen.getByTestId("plan-fold-done"))
    expect(orderRef.current.map((u) => u.sectionKey)).toEqual(["EXO", "GEN"])
    rerender(<PlanBoard units={BOOKS} now={NOW} projectId="p1" orderRef={orderRef}
      selectedId={null} onSelect={vi.fn()} />)
  })
})
