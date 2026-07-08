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
    const { container } = render(<WorkloadRollup jwt="jwt" orgId={1} />)
    await waitFor(() => expect(mockGetWorkload).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
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
    fireEvent.click(screen.getByRole("button", { name: /Remove assignment/ }))

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
    fireEvent.click(screen.getByRole("button", { name: /Remove assignment/ }))

    await waitFor(() => expect(screen.getByText(/role too low/)).toBeInTheDocument())
    // Row stays — removal failed, nothing was cleared.
    expect(screen.getByText("anna")).toBeInTheDocument()
  })
})
