// AQU-1969 (Sam, 2026-10-19): the Team card's validation rows carry the org
// workload's one-click × for whoever may unassign.
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TeamValidationList } from "./TeamValidationList"
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

  it("one click unassigns that row and it goes at once", async () => {
    const onRemove = vi.fn(async () => {})
    render(<TeamValidationList validations={rows} showLane={false} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId("overview-team-validation-remove-v1"))
    expect(onRemove).toHaveBeenCalledWith("v1")
    await waitFor(() => expect(screen.queryByTestId("overview-team-validation-v1")).toBeNull())
    expect(screen.getByTestId("overview-team-validation-v2")).toBeInTheDocument()
  })

  it("keeps the row and says why when the server refuses", async () => {
    const onRemove = vi.fn(async () => { throw new Error("role too low for assignment.unassign") })
    render(<TeamValidationList validations={rows} showLane={false} onRemove={onRemove} />)
    fireEvent.click(screen.getByTestId("overview-team-validation-remove-v2"))
    expect(await screen.findByText("role too low for assignment.unassign")).toBeInTheDocument()
    expect(screen.getByTestId("overview-team-validation-v2")).toBeInTheDocument()
  })
})
