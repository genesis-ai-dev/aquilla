// AQU-581: ProjectHandedOut — a lane coordinator's own hand-outs, removable.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProjectHandedOut } from "./ProjectHandedOut"
import type { GivenAssignment } from "@/lib/sync/assignments"

vi.mock("@/lib/sync/assignments", () => ({
  getAssignmentsGivenByMe: vi.fn(),
  unassignAssignment: vi.fn(),
}))

import { getAssignmentsGivenByMe, unassignAssignment } from "@/lib/sync/assignments"
const mockGiven = vi.mocked(getAssignmentsGivenByMe)
const mockUnassign = vi.mocked(unassignAssignment)

function given(overrides: Partial<GivenAssignment> = {}): GivenAssignment {
  return {
    assignmentId: "a-1",
    fileId: "file-1",
    assigneeUserId: 3,
    username: "bob",
    scopeLabel: "Genesis 1",
    targetLang: "Spanish",
    cellsTotal: 10,
    cellsDone: 0,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ProjectHandedOut", () => {
  it("renders nothing when the member has handed nothing out", async () => {
    mockGiven.mockResolvedValue([])
    const { container } = render(<ProjectHandedOut projectId="p" jwt="j" author="carol" />)
    await waitFor(() => expect(mockGiven).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })

  it("lists each hand-out with who it went to and its language", async () => {
    mockGiven.mockResolvedValue([given()])
    render(<ProjectHandedOut projectId="p" jwt="j" author="carol" />)
    expect(await screen.findByText("Handed out by you")).toBeTruthy()
    expect(screen.getByText("Genesis 1")).toBeTruthy()
    expect(screen.getByText("To bob")).toBeTruthy()
    expect(screen.getByText("Spanish")).toBeTruthy()
  })

  it("removes an assignment and drops its row", async () => {
    mockGiven.mockResolvedValue([given(), given({ assignmentId: "a-2", scopeLabel: "Genesis 2" })])
    mockUnassign.mockResolvedValue(undefined)
    const onRemoved = vi.fn()
    render(<ProjectHandedOut projectId="p" jwt="j" author="carol" onRemoved={onRemoved} />)
    fireEvent.click(await screen.findByRole("button", { name: /Genesis 1 \(bob\)/ }))
    await waitFor(() => expect(screen.queryByText("Genesis 1")).toBeNull())
    expect(mockUnassign).toHaveBeenCalledWith({ jwt: "j", projectId: "p", fileId: "file-1", author: "carol", assignmentId: "a-1" })
    expect(onRemoved).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Genesis 2")).toBeTruthy()
  })

  it("keeps the row and says why when the server refuses", async () => {
    mockGiven.mockResolvedValue([given()])
    mockUnassign.mockRejectedValue(new Error("role too low for assignment.unassign"))
    render(<ProjectHandedOut projectId="p" jwt="j" author="carol" />)
    fireEvent.click(await screen.findByRole("button", { name: /Genesis 1 \(bob\)/ }))
    expect(await screen.findByText(/role too low/)).toBeTruthy()
    expect(screen.getByText("Genesis 1")).toBeTruthy()
  })
})
