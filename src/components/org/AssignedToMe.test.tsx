import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { AssignedToMe } from "./AssignedToMe"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 400, name: "contributor" } }]),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/lib/frontier/portfolio", () => ({
  getPortfolio: vi.fn(async () => [
    { id: "pa", name: "John" },
    { id: "pb", name: "Mark" },
  ]),
}))
vi.mock("@/lib/sync/assignments", () => ({ getMyAssignments: vi.fn() }))

import { getMyAssignments } from "@/lib/sync/assignments"
const mockGetMy = vi.mocked(getMyAssignments)

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())

function renderInbox() {
  return render(
    <MemoryRouter>
      <OrgProvider>
        <AssignedToMe />
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("AssignedToMe", () => {
  it("aggregates the caller's open assignments across projects with progress", async () => {
    mockGetMy.mockImplementation(async (_jwt: string, projectId: string) =>
      projectId === "pa"
        ? [{ assignmentId: "a1", projectId: "pa", scopeKind: "books", scopeLabel: "John", deadline: "2026-06-30", note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 }]
        : [{ assignmentId: "a2", projectId: "pb", scopeKind: "chapters", scopeLabel: "Mark · MRK 1", deadline: null, note: null, cellsTotal: 5, cellsDone: 5, createdAt: 100 }],
    )
    renderInbox()

    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())
    expect(screen.getByText("Mark · MRK 1")).toBeInTheDocument()
    expect(screen.getByText("4/10 cells · 40%")).toBeInTheDocument()
    expect(screen.getByText("5/5 cells · 100%")).toBeInTheDocument()
    expect(screen.getByText("Due 2026-06-30")).toBeInTheDocument()
  })

  it("shows an empty state when there are no assignments", async () => {
    mockGetMy.mockResolvedValue([])
    renderInbox()
    await waitFor(() => expect(screen.getByText("You have no open assignments.")).toBeInTheDocument())
  })

  it("skips projects the caller cannot read (allSettled tolerates a 403)", async () => {
    mockGetMy.mockImplementation(async (_jwt: string, projectId: string) => {
      if (projectId === "pa") {
        return [{ assignmentId: "a1", projectId: "pa", scopeKind: "books", scopeLabel: "John", deadline: null, note: null, cellsTotal: 2, cellsDone: 1, createdAt: 1 }]
      }
      throw new Error("getMyAssignments failed: HTTP 403")
    })
    renderInbox()

    await waitFor(() => expect(screen.getByText("John")).toBeInTheDocument())
    expect(screen.getByText("1/2 cells · 50%")).toBeInTheDocument()
  })
})
