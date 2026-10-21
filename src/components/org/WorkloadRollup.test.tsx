import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { WorkloadRollup } from "./WorkloadRollup"

vi.mock("@/lib/sync/assignments", () => ({ getWorkload: vi.fn(), unassignAssignment: vi.fn() }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
import { getWorkload, unassignAssignment } from "@/lib/sync/assignments"
const mockGetWorkload = vi.mocked(getWorkload)
const mockUnassign = vi.mocked(unassignAssignment)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("WorkloadRollup", () => {
  it("renders one row per assignment, with its project + progress (AQU-494)", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", assigneeUserId: 3, username: "bob", scopeLabel: "Mark 1", cellsTotal: 4, cellsDone: 4, deadline: null },
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("Team workload")).toBeInTheDocument())
    expect(screen.getByText("anna")).toBeInTheDocument()
    // AQU-494: each row shows which project the assignment belongs to.
    expect(screen.getByText("John")).toBeInTheDocument()
    expect(screen.getByText("4/10")).toBeInTheDocument()
    expect(screen.getByText("bob")).toBeInTheDocument()
    expect(screen.getByText("Mark")).toBeInTheDocument()
    expect(screen.getByText("4/4")).toBeInTheDocument()
    expect(mockGetWorkload).toHaveBeenCalledWith("jwt", 1)
  })

  it("renders nothing when the caller is not a manager (forbidden → caught silently)", async () => {
    // Simulate what our helpers now throw: a UserError with a human message.
    // WorkloadRollup swallows any rejection so non-manager callers see nothing.
    mockGetWorkload.mockRejectedValue(
      Object.assign(new Error("You don't have permission to do that for this org."), {
        name: "UserError",
        category: "forbidden",
        status: 403,
        raw: "",
      })
    )
    const { container } = render(<WorkloadRollup jwt="jwt" orgId={1} />)
    await waitFor(() => expect(mockGetWorkload).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("Team workload")).not.toBeInTheDocument()
  })

  it("renders nothing when there are no open assignments", async () => {
    mockGetWorkload.mockResolvedValue([])
    const { container } = render(<WorkloadRollup jwt="jwt" orgId={1} action={<span>Visibility control</span>} />)
    await waitFor(() => expect(mockGetWorkload).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("Visibility control")).not.toBeInTheDocument()
  })

  it("places section actions in the rendered section header", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} action={<span>Visibility control</span>} />)

    const heading = await screen.findByText("Team workload")
    expect(heading.closest("section")).toHaveTextContent("Visibility control")
  })

  it("hides Remove when the caller is below the project's assignment floor", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, deadline: null },
    ])
    render(
      <WorkloadRollup
        jwt="jwt"
        orgId={1}
        canUnassignProject={(projectId) => projectId !== "pa"}
      />,
    )

    await screen.findByText("Team workload")
    expect(screen.queryByRole("button", { name: /Remove assignment/ })).not.toBeInTheDocument()
  })

  it("removes a completed (100%) assignment on click — it disappears (AQU-494 bug 1)", async () => {
    // "Completed" here means 100% progress, not a completed_at flag — nothing
    // in this system ever sets completed_at (see assignments.ts service docs);
    // this is exactly the case the reporter hit: full progress, still open,
    // and previously no way to clear it at all.
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 10, deadline: null },
    ])
    mockUnassign.mockResolvedValue(undefined)
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /^Remove assignment/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Confirm removing assignment/ }))

    await waitFor(() => expect(mockUnassign).toHaveBeenCalledWith({
      jwt: "jwt",
      projectId: "pa",
      fileId: "f1",
      author: "wendi",
      assignmentId: "a1",
    }))
    // Row disappears immediately; the whole section unmounts since it was the
    // only row (renders nothing — matches the "no open assignments" case).
    await waitFor(() => expect(screen.queryByText("anna")).not.toBeInTheDocument())
  })

  it("surfaces a removal failure inline instead of silently no-op'ing", async () => {
    mockGetWorkload.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", assigneeUserId: 2, username: "anna", scopeLabel: "Genesis", cellsTotal: 3, cellsDone: 1, deadline: null },
    ])
    mockUnassign.mockRejectedValue(new Error("role too low for assignment.unassign"))
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    await waitFor(() => expect(screen.getByText("anna")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /^Remove assignment/ }))
    fireEvent.click(screen.getByRole("button", { name: /^Confirm removing assignment/ }))

    await waitFor(() => expect(screen.getByText(/role too low/)).toBeInTheDocument())
    // Row stays — removal failed, nothing was cleared.
    expect(screen.getByText("anna")).toBeInTheDocument()
  })
})

// AQU-1969: validate assignments read the assignee's own approvals, under
// their own heading, furthest behind first.
describe("WorkloadRollup validators", () => {
  const counts = (total: number, validated: number, waiting: number, changed: number) => ({ total, validated, waiting, changed })
  const base = { projectId: "pa", projectName: "Torah", fileId: "f1", deadline: null }

  it("lists validators apart from translators, furthest behind first, in the shared wording", async () => {
    mockGetWorkload.mockResolvedValue([
      // Newest first from the server.
      { ...base, assignmentId: "v-near", assigneeUserId: 3, username: "bo", scopeLabel: "Deuteronomy 11", cellsTotal: 10, cellsDone: 9, kind: "validate", validation: { text: counts(10, 9, 0, 0), audio: counts(10, 0, 10, 0) } },
      { ...base, assignmentId: "v-far", assigneeUserId: 2, username: "ana", scopeLabel: "Deuteronomy 1–10", cellsTotal: 40, cellsDone: 34, kind: "validate", validation: { text: counts(40, 34, 0, 2), audio: counts(40, 3, 30, 1) } },
      { ...base, assignmentId: "t1", assigneeUserId: 4, username: "tom", scopeLabel: "Genesis", cellsTotal: 10, cellsDone: 4, kind: "translate" },
    ])
    render(<WorkloadRollup jwt="jwt" orgId={1} />)

    const group = await screen.findByTestId("workload-validations")
    expect(screen.getByText("Validation assignments")).toBeInTheDocument()
    const order = [...group.querySelectorAll("[data-testid^=workload-validation-v]")]
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => !id?.includes("-text-") && !id?.includes("-audio-"))
    expect(order).toEqual(["workload-validation-v-far", "workload-validation-v-near"])
    expect(screen.getByTestId("workload-validation-text-v-far").textContent).toBe(
      "Text validated 34 of 40 · 6 left · 2 changed since",
    )
    // Three of her lines have recordings: the audio line is there.
    expect(screen.getByTestId("workload-validation-audio-v-far").textContent).toBe(
      "Audio validated 3 of 40 · 7 left · 1 changed since · waiting on a recording (30)",
    )
    // The translator's row is outside the group and reads as it always has.
    expect(group.textContent).not.toContain("tom")
    expect(screen.getByText("4/10")).toBeInTheDocument()
  })
})
