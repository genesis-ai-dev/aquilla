import { describe, it, expect, vi } from "vitest"
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
  render(<PlanBoard units={units} now={NOW} selectedId={selectedId} onSelect={onSelect} />)
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
    const rows = within(screen.getByTestId("plan-group-in_progress")).getAllByRole("button")
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

describe("audio columns", () => {
  it("hides audio bars entirely on a text-only project", () => {
    renderBoard([unit({ filledCount: 50 })])
    expect(screen.queryByLabelText(/^Audio/)).toBeNull()
  })

  it("shows them as soon as one unit has a recording", () => {
    renderBoard([unit({ filledCount: 50, audioCount: 20, audioValidatedCount: 5 })])
    expect(screen.getByLabelText(/^Audio/)).toBeInTheDocument()
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
