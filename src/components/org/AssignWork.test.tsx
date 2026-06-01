import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { AssignWork } from "./AssignWork"

vi.mock("@/lib/frontier/orgs", () => ({ listOrgMembers: vi.fn() }))
vi.mock("@/lib/sync/assignments", () => ({ createAssignment: vi.fn() }))

import { listOrgMembers } from "@/lib/frontier/orgs"
import { createAssignment } from "@/lib/sync/assignments"

const mockList = vi.mocked(listOrgMembers)
const mockCreate = vi.mocked(createAssignment)

const members = [
  { userId: 2, username: "anna", role: { level: 400, name: "contributor" } },
] as unknown as Awaited<ReturnType<typeof listOrgMembers>>

const files = [
  { id: "f1", name: "John" },
  { id: "f2", name: "Mark" },
]

function renderAssign(onAssigned = vi.fn()) {
  return render(
    <AssignWork projectId="p1" files={files} orgId={1} jwt="jwt" author="wendi" onAssigned={onAssigned} />,
  )
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("AssignWork", () => {
  it("collapses to an Assign… button", () => {
    renderAssign()
    expect(screen.getByRole("button", { name: "Assign…" })).toBeInTheDocument()
  })

  it("opens, loads members, and emits a book-scope assignment.create", async () => {
    mockList.mockResolvedValue(members)
    mockCreate.mockResolvedValue("as-new")
    const onAssigned = vi.fn()
    renderAssign(onAssigned)

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await waitFor(() => expect(screen.getByRole("option", { name: "anna" })).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "2" } })
    // Book defaults to the first file (John); chapter left empty → book scope.
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          fileId: "f1",
          author: "wendi",
          assigneeUserId: 2,
          scopeKind: "books",
          scope: [{ fileId: "f1" }],
          scopeLabel: "John",
        }),
      ),
    )
    expect(onAssigned).toHaveBeenCalled()
    expect(await screen.findByText(/Assigned John to anna/)).toBeInTheDocument()
  })

  it("emits a chapter-scope assignment when a chapter is entered", async () => {
    mockList.mockResolvedValue(members)
    mockCreate.mockResolvedValue("as-2")
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await waitFor(() => expect(screen.getByRole("option", { name: "anna" })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "2" } })
    fireEvent.change(screen.getByLabelText("Chapter (optional)"), { target: { value: "GEN 1" } })
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          scopeKind: "chapters",
          scope: [{ fileId: "f1", chapter: "GEN 1" }],
          scopeLabel: "John · GEN 1",
        }),
      ),
    )
  })

  it("surfaces a server rejection (e.g. role too low)", async () => {
    mockList.mockResolvedValue(members)
    mockCreate.mockRejectedValue(new Error("role too low for assignment.create"))
    renderAssign()

    fireEvent.click(screen.getByRole("button", { name: "Assign…" }))
    await waitFor(() => expect(screen.getByRole("option", { name: "anna" })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "2" } })
    fireEvent.click(screen.getByRole("button", { name: "Assign" }))

    expect(await screen.findByText(/role too low/)).toBeInTheDocument()
    expect(mockCreate).toHaveBeenCalled()
  })
})
