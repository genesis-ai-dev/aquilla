// FRO-192: ProjectAssignedToMe tests — pickup list rendering + jump.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProjectAssignedToMe } from "./ProjectAssignedToMe"
import type { MyAssignment } from "@/lib/sync/assignments"

vi.mock("@/lib/sync/assignments", () => ({
  getMyAssignments: vi.fn(),
}))

import { getMyAssignments } from "@/lib/sync/assignments"
const mockGetMyAssignments = vi.mocked(getMyAssignments)

function makeAssignment(overrides: Partial<MyAssignment> = {}): MyAssignment {
  return {
    assignmentId: "asgn-1",
    projectId: "proj-1",
    scopeKind: "books",
    scopeLabel: "Genesis",
    deadline: null,
    note: null,
    cellsTotal: 10,
    cellsDone: 3,
    createdAt: Date.now(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ProjectAssignedToMe", () => {
  it("renders nothing when there are no assignments", async () => {
    mockGetMyAssignments.mockResolvedValue([])
    const { container } = render(
      <ProjectAssignedToMe projectId="proj-1" jwt="test-jwt" />,
    )
    // Wait for the effect to run
    await waitFor(() => expect(mockGetMyAssignments).toHaveBeenCalledTimes(1))
    // Component self-hides on empty
    expect(container.firstChild).toBeNull()
  })

  it("renders assignment rows with progress when assignments exist", async () => {
    mockGetMyAssignments.mockResolvedValue([
      makeAssignment({ scopeLabel: "Genesis", cellsDone: 3, cellsTotal: 10 }),
      makeAssignment({ assignmentId: "asgn-2", scopeLabel: "Exodus", cellsDone: 5, cellsTotal: 5 }),
    ])
    render(<ProjectAssignedToMe projectId="proj-1" jwt="test-jwt" />)
    await waitFor(() => expect(screen.getByText("My assignments")).toBeTruthy())
    expect(screen.getByText("Genesis")).toBeTruthy()
    expect(screen.getByText("Exodus")).toBeTruthy()
    // Progress: 3/10 = 30%, 5/5 = 100%
    expect(screen.getByText("3/10 cells")).toBeTruthy()
    expect(screen.getByText("5/5 cells")).toBeTruthy()
    expect(screen.getByText("30%")).toBeTruthy()
    expect(screen.getByText("100%")).toBeTruthy()
  })

  it("calls onJumpToScopeLabel when a row is clicked", async () => {
    mockGetMyAssignments.mockResolvedValue([
      makeAssignment({ scopeLabel: "Genesis" }),
    ])
    const onJump = vi.fn()
    render(
      <ProjectAssignedToMe projectId="proj-1" jwt="test-jwt" onJumpToScopeLabel={onJump} />,
    )
    await waitFor(() => expect(screen.getByText("Genesis")).toBeTruthy())
    fireEvent.click(screen.getByText("Genesis").closest("button")!)
    expect(onJump).toHaveBeenCalledWith("Genesis")
  })

  it("shows deadline when present", async () => {
    mockGetMyAssignments.mockResolvedValue([
      makeAssignment({ scopeLabel: "Genesis", deadline: "2026-07-01" }),
    ])
    render(<ProjectAssignedToMe projectId="proj-1" jwt="test-jwt" />)
    await waitFor(() => expect(screen.getByText(/Due 2026-07-01/)).toBeTruthy())
  })

  it("collapses and re-expands when the header is clicked", async () => {
    mockGetMyAssignments.mockResolvedValue([makeAssignment()])
    render(<ProjectAssignedToMe projectId="proj-1" jwt="test-jwt" />)
    await waitFor(() => expect(screen.getByText("Genesis")).toBeTruthy())
    // Collapse
    fireEvent.click(screen.getByText("My assignments"))
    expect(screen.queryByText("Genesis")).toBeNull()
    // Re-expand
    fireEvent.click(screen.getByText("My assignments"))
    expect(screen.getByText("Genesis")).toBeTruthy()
  })

  it("re-fetches when refreshKey increments", async () => {
    mockGetMyAssignments.mockResolvedValue([makeAssignment()])
    const { rerender } = render(
      <ProjectAssignedToMe projectId="proj-1" jwt="test-jwt" refreshKey={0} />,
    )
    await waitFor(() => expect(mockGetMyAssignments).toHaveBeenCalledTimes(1))
    rerender(<ProjectAssignedToMe projectId="proj-1" jwt="test-jwt" refreshKey={1} />)
    await waitFor(() => expect(mockGetMyAssignments).toHaveBeenCalledTimes(2))
  })
})
