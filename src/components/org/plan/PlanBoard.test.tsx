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

/**
 * AQU-1278. 100 cells with 96 validated is four short, under the
 * max(6% of 100, 7) = 7 threshold, so this unit is Nearly complete. It carries
 * no target date on purpose: the whole case the group exists for is the unit
 * nobody dated, which no other signal on the board could surface.
 */
function nearlyDone(over: Partial<PlanUnit> = {}): PlanUnit {
  return unit({ filledCount: 100, validatedCount: 96, ...over })
}

describe("grouping", () => {
  it("puts Nearly complete under the two dated groups and above In progress, Done last", () => {
    // The rung AQU-1278 settled on. A blown date still outranks "a few cells
    // left", so Overdue and Due soon keep the top — but a unit four cells from
    // finished is more actionable than the rest of In progress, so it sits
    // directly above it rather than being buried inside it.
    renderBoard([
      unit({ fileId: "a", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "b", targetDate: "2026-08-01" }),
      unit({ fileId: "c", filledCount: 5 }),
      unit({ fileId: "d" }),
      unit({ fileId: "e", targetDate: "2026-09-05", filledCount: 5 }),
      nearlyDone({ fileId: "f" }),
    ])
    const groups = screen.getAllByTestId(/^plan-group-/).map((el) => el.getAttribute("data-testid"))
    expect(groups).toEqual([
      "plan-group-overdue",
      "plan-group-soon",
      "plan-group-nearly_complete",
      "plan-group-in_progress",
      "plan-group-not_started",
      "plan-group-done",
    ])
  })

  it("sends a unit a handful of cells from done to the new group, not to In progress", () => {
    // The row this feature is for: before AQU-1278 a book four cells short and
    // a book at 40% sat in the same group, sorted by a date neither of them
    // had, and only the width of a bar told them apart.
    renderBoard([
      nearlyDone({ fileId: "near", fileName: "Titus" }),
      unit({ fileId: "mid", fileName: "Judges", filledCount: 40 }),
    ])
    const near = screen.getByTestId("plan-group-nearly_complete")
    expect(within(near).getByTestId("plan-row-near-")).toBeInTheDocument()
    expect(
      within(screen.getByTestId("plan-group-in_progress")).getByTestId("plan-row-mid-"),
    ).toBeInTheDocument()
    // And above it on the page, which is the entire claim of the new rung.
    const groups = screen.getAllByTestId(/^plan-group-/).map((el) => el.getAttribute("data-testid"))
    expect(groups).toEqual(["plan-group-nearly_complete", "plan-group-in_progress"])
  })

  it("hides empty groups so a healthy project reads short", () => {
    renderBoard([unit({ filledCount: 3 })])
    expect(screen.getByTestId("plan-group-in_progress")).toBeInTheDocument()
    expect(screen.queryByTestId("plan-group-overdue")).toBeNull()
    expect(screen.queryByTestId("plan-group-done")).toBeNull()
  })

  it("counts the rows in each group header", () => {
    renderBoard([
      unit({ fileId: "a" }), unit({ fileId: "b" }), unit({ fileId: "c", filledCount: 1 }),
      nearlyDone({ fileId: "d" }), nearlyDone({ fileId: "e", validatedCount: 100 }),
    ])
    expect(within(screen.getByTestId("plan-group-not_started")).getByText("2")).toBeInTheDocument()
    expect(within(screen.getByTestId("plan-group-nearly_complete")).getByText("2")).toBeInTheDocument()
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

  it("gives nearly complete its own pill, ahead of in progress in the strip", () => {
    // AQU-1278. Ahead of it because the strip reads in urgency order like the
    // groups below, and this is the one number a manager can act on today.
    renderBoard([
      nearlyDone({ fileId: "a" }),
      nearlyDone({ fileId: "b", validatedCount: 99 }),
      unit({ fileId: "c", filledCount: 40 }),
    ])
    expect(screen.getByTestId("plan-summary-nearly-complete")).toHaveTextContent("2 nearly complete")
    // Counted APART from in progress, never on top of it: two pills describing
    // the same unit would make the strip add up to more than the project.
    expect(screen.getByTestId("plan-summary-in-progress")).toHaveTextContent("1 in progress")
    const pills = screen.getAllByTestId(/^plan-summary/).map((el) => el.getAttribute("data-testid"))
    expect(pills).toEqual([
      "plan-summary",
      "plan-summary-nearly-complete",
      "plan-summary-in-progress",
    ])
  })

  it("drops the nearly complete pill when nothing is close, like its siblings", () => {
    renderBoard([unit({ filledCount: 40 })])
    expect(screen.queryByTestId("plan-summary-nearly-complete")).toBeNull()
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

  it("KEEPS EVERY SUMMARY PILL PROJECT-WIDE while filtered, the AQU-1278 one included", () => {
    // The load-bearing invariant. "1 of 1 done" under a filter that hid the
    // other three would be a lie, and the strip is the one thing on this card a
    // reader trusts without checking.
    //
    // The new pill is pinned HERE rather than in a test of its own: it is the
    // same invariant, and a parallel test is exactly how the two drift until
    // one pill counts the filtered view and the others count the project.
    renderBoard([
      ...BOOKS,
      nearlyDone({ fileId: "b", sectionKey: "NUM", fileName: "Bible.usfm", validatedCount: 97 }),
    ])
    expect(screen.getByTestId("plan-summary-nearly-complete")).toHaveTextContent("1 nearly complete")
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "genesis" } })
    expect(screen.getByTestId("plan-summary")).toHaveTextContent("1 of 4 done")
    expect(screen.getByTestId("plan-summary-nearly-complete")).toHaveTextContent("1 nearly complete")
    expect(screen.getByTestId("plan-filter-note")).toHaveTextContent("Showing 1 of 4.")
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

// ── every row is drawn; the cap AQU-1255 added is gone ─────────────────────

/**
 * `n` in-progress units in one unfolded group. Names are zero-padded because
 * undated units fall back to a label sort, and "Book 10" sorts before "Book 2".
 */
function manyUnits(n: number, over: Partial<PlanUnit> = {}): PlanUnit[] {
  return Array.from({ length: n }, (_, i) => {
    const nth = String(i + 1).padStart(2, "0")
    return unit({ fileId: "b", sectionKey: `S${nth}`, fileName: `Book ${nth}`, filledCount: 40, ...over })
  })
}

describe("a long plan", () => {
  it("draws every row, with no Show all button to press", () => {
    // AQU-1255 drew the first five and hid the rest behind "Show all 12". Sam,
    // 2026-09-16: a manager opening the plan wants the plan. Folding a group
    // is the way to see less, because a fold names what it is hiding.
    renderBoard(manyUnits(12))
    expect(rowCount()).toBe(12)
    expect(screen.queryByTestId("plan-show-all")).toBeNull()
  })

  it("still hides a folded group's rows, and only those", () => {
    renderBoard([
      ...manyUnits(3, { targetDate: "2026-08-01" }).map((u, i) => ({ ...u, sectionKey: `O${i}` })),
      ...manyUnits(4).map((u, i) => ({ ...u, sectionKey: `P${i}` })),
    ])
    expect(rowCount()).toBe(7)
    fireEvent.click(screen.getByTestId("plan-fold-overdue"))
    expect(rowCount()).toBe(4)
    // The header keeps its own honest count while its rows are away.
    expect(screen.getByTestId("plan-group-overdue")).toHaveTextContent("3")
  })

  it("draws every match under a filter", () => {
    renderBoard(manyUnits(12))
    // The filter matches the unit LABEL, which for a sub-file unit is its
    // section key — "S01"…"S12", not the file name beside it.
    fireEvent.change(screen.getByTestId("plan-filter"), { target: { value: "S0" } })
    expect(rowCount()).toBe(9) // S01…S09
    expect(screen.getByTestId("plan-filter-note")).toHaveTextContent("Showing 9 of 12.")
  })

  it("draws every row in the In order arrangement too", () => {
    renderBoard(manyUnits(12))
    fireEvent.click(screen.getByTestId("plan-view-order"))
    expect(screen.getByTestId("plan-order-list").querySelectorAll("li")).toHaveLength(12)
  })

  it("lets the arrow keys walk past where the cap used to stop", () => {
    // Selection is a controlled prop, so one keypress from a known row is the
    // whole assertion: standing on the fifth row, ArrowDown reaches the sixth.
    // Under AQU-1255 the ordered list ended at five and this clamped to itself.
    const { onSelect } = renderBoard(manyUnits(12), "b:S05")
    fireEvent.keyDown(screen.getByRole("region", { name: /Planning units/ }), { key: "ArrowDown" })
    expect(onSelect).toHaveBeenLastCalledWith("b:S06")
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

  it("hands over every row of a long plan", () => {
    // The inspector walks this ref. It used to stop at AQU-1255's five drawn
    // rows; with the cap gone it is the whole plan, every time.
    const orderRef = { current: [] as PlanUnit[] }
    render(
      <PlanBoard units={manyUnits(12)} now={NOW} projectId="p1" orderRef={orderRef}
        selectedId={null} onSelect={vi.fn()} />,
    )
    expect(orderRef.current.length).toBe(12)
  })
})

// ── AQU-1278: the third column, after Sam's review of the build ─────────────

describe("what the third column says", () => {
  const withProps = (units: PlanUnit[], props: Partial<React.ComponentProps<typeof PlanBoard>> = {}) =>
    render(
      <PlanBoard units={units} now={NOW} projectId="p1" selectedId={null}
        onSelect={vi.fn()} {...props} />,
    )

  const dateCell = () => screen.getByTestId("plan-date-f1-").parentElement!

  it("drops the noun when two shortfall terms share the line", () => {
    // 300 cells, 294 written, 286 validated: six to translate and eight to
    // validate, fourteen short against a threshold of eighteen. In full this
    // read "6 cells to translate · 8 cells to validate", which wrapped the row.
    withProps([unit({ totalCount: 300, filledCount: 294, validatedCount: 286 })])
    expect(dateCell()).toHaveTextContent("6 to translate · 8 to validate")
  })

  it("keeps the noun when the line carries one term", () => {
    withProps([nearlyDone()])
    expect(dateCell()).toHaveTextContent("4 cells to validate")
  })

  it("joins the short chapters with a conjunction", () => {
    withProps([nearlyDone()], { shortChaptersByUnit: new Map([["f1:", ["12", "40"]]]) })
    expect(dateCell()).toHaveTextContent("chapters 12 and 40")
  })

  it("names three chapters and counts the rest, with one 'and' between them", () => {
    withProps([nearlyDone()], {
      shortChaptersByUnit: new Map([["f1:", ["4", "9", "17", "22", "28"]]]),
    })
    // "4, 9, 17 and 2 more" — the conjunction belongs to the remainder here, so
    // the named list keeps the plain join or the line reads "…, and 17 and 2 more".
    expect(dateCell()).toHaveTextContent("4, 9, 17 and 2 more")
  })

  it("says a finished unit is not marked done, rather than that it has no date", () => {
    withProps([unit({ filledCount: 100, validatedCount: 100, lastEditAt: NOW - 3600_000 })])
    const cell = dateCell()
    expect(cell).toHaveTextContent("Nothing left")
    expect(cell).toHaveTextContent("not marked done")
    expect(cell).not.toHaveTextContent("no target date")
  })

  it("marks a unit nobody holds as unassigned, once its assignments are known", () => {
    withProps([unit({ filledCount: 40, lastEditAt: NOW - 3600_000 })], {
      assigneesByUnit: new Map([["f1:", []]]),
    })
    expect(dateCell()).toHaveTextContent("unassigned")
  })

  it("stays silent about a unit whose assignments nobody has read yet", () => {
    // `undefined` is "not asked" and `[]` is "asked, nobody" — there is no
    // project-wide assignee read, so the board only learns a unit's people
    // when a manager opens it. Printing "unassigned" for the first would send
    // someone to staff a book that already has two people on it.
    withProps([unit({ filledCount: 40, lastEditAt: NOW - 3600_000 })], {
      assigneesByUnit: new Map(),
    })
    expect(dateCell()).not.toHaveTextContent("unassigned")
  })

  it("does not call a nearly-complete unit unassigned, where the line says what is left", () => {
    withProps([nearlyDone()], { assigneesByUnit: new Map([["f1:", []]]) })
    expect(dateCell()).not.toHaveTextContent("unassigned")
  })
})
