// AQU-1969 (Sam, 2026-10-19/20): the Team card's validation rows carry the org
// workload's × for whoever may unassign; it asks in place: Confirm or Cancel.
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

  it("× then Confirm unassigns that row and it goes at once", async () => {
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

// Sam, 2026-10-20: the × asks before it removes — in place, no dialog: a red
// Confirm with a Cancel beside it.
describe("RemoveAssignmentButton", () => {
  const x = () => screen.queryByTestId("overview-team-validation-remove-v1")
  const confirm = () => screen.queryByTestId("overview-team-validation-remove-v1-confirm")
  const cancel = () => screen.queryByTestId("overview-team-validation-remove-v1-cancel")

  it("turns into Confirm and Cancel; Cancel turns it back into the × and removes nothing", () => {
    const onRemove = vi.fn(async () => {})
    render(<TeamValidationList validations={rows} showLane={false} onRemove={onRemove} />)
    fireEvent.click(x()!)
    expect(x()).toBeNull()
    expect(confirm()).toHaveTextContent("Confirm")
    expect(confirm()).toHaveAccessibleName("Confirm removing assignment: GEN 1 (carol)")
    expect(confirm()).toHaveFocus()
    expect(cancel()).toHaveTextContent("Cancel")
    expect(cancel()).toHaveAccessibleName("Cancel removing assignment: GEN 1 (carol)")
    fireEvent.click(cancel()!)
    expect(x()).toBeInTheDocument()
    expect(confirm()).toBeNull()
    expect(cancel()).toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it("stays up while focus moves between Confirm and Cancel", () => {
    render(<TeamValidationList validations={rows} showLane={false} onRemove={vi.fn(async () => {})} />)
    fireEvent.click(x()!)
    fireEvent.blur(confirm()!, { relatedTarget: cancel() })
    expect(confirm()).toBeInTheDocument()
    expect(cancel()).toBeInTheDocument()
  })

  it("turns back into the × on Escape, on leaving it, or after a few seconds", async () => {
    vi.useFakeTimers()
    try {
      const onRemove = vi.fn(async () => {})
      render(<TeamValidationList validations={rows} showLane={false} onRemove={onRemove} />)
      fireEvent.click(x()!)
      fireEvent.keyDown(confirm()!, { key: "Escape" })
      expect(x()).toBeInTheDocument()
      fireEvent.click(x()!)
      fireEvent.keyDown(cancel()!, { key: "Escape" })
      expect(x()).toBeInTheDocument()
      fireEvent.click(x()!)
      fireEvent.blur(confirm()!)
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
