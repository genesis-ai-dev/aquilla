// AQU-1969 (Sam, 2026-10-19/20): the Team card's validation rows carry the org
// workload's × for whoever may unassign; it asks "Are you sure?" in place.
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TeamValidationList } from "./TeamValidationList"
import { CONFIRM_TIMEOUT_MS } from "./RemoveAssignmentButton"
import type { ValidationAssignment } from "@/lib/sync/assignments"

const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })
const row = (assignmentId: string, username: string, validated: number): ValidationAssignment => ({
  assignmentId,
  assigneeUserId: 3,
  username,
  scopeLabel: "GEN 1",
  targetLang: "",
  deadline: null,
  validation: { text: counts(7, validated, 0, 0), audio: counts(7, 0, 7, 0) },
})
const rows = [row("v1", "carol", 2), row("v2", "dana", 5)]

describe("TeamValidationList", () => {
  it("has an × on each row for whoever may unassign, and none for anyone else", () => {
    const { rerender } = render(<TeamValidationList validations={rows} showLane={false} onRemove={vi.fn(async () => {})} />)
    expect(screen.getByTestId("overview-team-validation-remove-v1")).toHaveAccessibleName("Remove assignment: GEN 1 (carol)")
    expect(screen.getByTestId("overview-team-validation-remove-v2")).toBeInTheDocument()
    rerender(<TeamValidationList validations={rows} showLane={false} />)
    expect(screen.queryByTestId("overview-team-validation-remove-v1")).toBeNull()
  })

  it("× then Are you sure? unassigns that row and it goes at once", async () => {
    const onRemove = vi.fn(async () => {})
    render(<TeamValidationList validations={rows} showLane={false} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId("overview-team-validation-remove-v1"))
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("overview-team-validation-remove-v1-confirm"))
    expect(onRemove).toHaveBeenCalledWith("v1")
    await waitFor(() => expect(screen.queryByTestId("overview-team-validation-v1")).toBeNull())
    expect(screen.getByTestId("overview-team-validation-v2")).toBeInTheDocument()
  })

  it("keeps the row and says why when the server refuses", async () => {
    const onRemove = vi.fn(async () => { throw new Error("role too low for assignment.unassign") })
    render(<TeamValidationList validations={rows} showLane={false} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId("overview-team-validation-remove-v2"))
    fireEvent.click(screen.getByTestId("overview-team-validation-remove-v2-confirm"))
    expect(await screen.findByText("role too low for assignment.unassign")).toBeInTheDocument()
    expect(screen.getByTestId("overview-team-validation-v2")).toBeInTheDocument()
  })
})

// Sam, 2026-10-20: the × asks before it removes — in place, no dialog.
describe("RemoveAssignmentButton", () => {
  it("turns into Are you sure?, and back into the × on Escape, on leaving it, or after a few seconds", async () => {
    vi.useFakeTimers()
    try {
      const onRemove = vi.fn(async () => {})
      render(<TeamValidationList validations={rows} showLane={false} onRemove={onRemove} />)
      const x = () => screen.queryByTestId("overview-team-validation-remove-v1")
      const sure = () => screen.queryByTestId("overview-team-validation-remove-v1-confirm")
      fireEvent.click(x()!)
      expect(sure()).toHaveTextContent("Are you sure?")
      expect(sure()).toHaveFocus()
      fireEvent.keyDown(sure()!, { key: "Escape" })
      expect(x()).toBeInTheDocument()
      fireEvent.click(x()!)
      fireEvent.blur(sure()!)
      expect(x()).toBeInTheDocument()
      fireEvent.click(x()!)
      act(() => { vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS) })
      expect(x()).toBeInTheDocument()
      expect(onRemove).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
