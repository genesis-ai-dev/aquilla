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
vi.mock("@/lib/sync/assignments", () => ({ getMyAssignmentsForOrg: vi.fn() }))

import { getMyAssignmentsForOrg } from "@/lib/sync/assignments"
const mockGetMy = vi.mocked(getMyAssignmentsForOrg)

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
  it("shows explicit progress while assignments are unresolved", async () => {
    mockGetMy.mockImplementationOnce(() => new Promise(() => {}))
    renderInbox()

    expect(
      await screen.findByRole("status", { name: "Loading assignments" }),
    ).toHaveAttribute("aria-busy", "true")
  })

  it("aggregates the caller's open assignments across projects with progress", async () => {
    // One org-level request (GET /orgs/:orgId/assignments/mine) replaces the
    // old per-project fan-out — rows arrive with projectName attached.
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", scopeKind: "books", scopeLabel: "John", targetLang: "", deadline: "2026-06-30", note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", scopeKind: "chapters", scopeLabel: "Mark · MRK 1", targetLang: "", deadline: null, note: null, cellsTotal: 5, cellsDone: 5, createdAt: 100 },
    ])
    renderInbox()

    await waitFor(() => expect(screen.getAllByText("John").length).toBeGreaterThan(0))
    expect(screen.getByText("Mark · MRK 1")).toBeInTheDocument()
    expect(screen.getByText("4/10 cells · 40%")).toBeInTheDocument()
    expect(screen.getByText("5/5 cells · 100%")).toBeInTheDocument()
    expect(screen.getByText("Due 2026-06-30")).toBeInTheDocument()
    expect(mockGetMy).toHaveBeenCalledWith("jwt", 1)
  })

  // AQU-729: the lane chip renders from laneLabel for EVERY assignment — the
  // pinned lane's name, or the project's default target language for a
  // default-lane assignment — so the assignee can always tell which language the
  // work is in. Deep-link routing still keys off targetLang: only a pinned lane
  // appends ?lane=; a default-lane assignment opens the project at its default
  // lane even though it shows a language chip. Supersedes AQU-538 (§3.5).
  it("renders the lane chip from laneLabel for pinned and default-lane assignments; ?lane= only for pinned", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", scopeKind: "books", scopeLabel: "John scope", targetLang: "es", laneLabel: "es", deadline: null, note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", scopeKind: "books", scopeLabel: "Mark scope", targetLang: "", laneLabel: "World English", deadline: null, note: null, cellsTotal: 5, cellsDone: 1, createdAt: 100 },
    ])
    renderInbox()

    await waitFor(() => expect(screen.getByText("John scope")).toBeInTheDocument())
    // Both assignments show a language chip — the pinned lane and the
    // default-lane fallback (the AQU-729 fix).
    expect(screen.getByText("es")).toBeInTheDocument()
    expect(screen.getByText("World English")).toBeInTheDocument()
    // The pinned assignment's link carries ?lane=es; the default-lane one still
    // doesn't (laneLabel is display-only, targetLang drives routing).
    const esLink = screen.getByText("John scope").closest("a")
    expect(esLink?.getAttribute("href")).toContain("?lane=es")
    const defLink = screen.getByText("Mark scope").closest("a")
    expect(defLink?.getAttribute("href")).not.toContain("lane=")
  })

  it("shows an empty state when there are no assignments", async () => {
    mockGetMy.mockResolvedValue([])
    renderInbox()
    await waitFor(() => expect(screen.getByText("You have no open assignments.")).toBeInTheDocument())
  })

  it("surfaces a failed org-level read as an error (no silent empty state)", async () => {
    // The single org read has no per-project fallback — a failure must be
    // visible, not rendered as "no assignments".
    // Simulate what our updated helpers now throw: a UserError with a human message.
    // (Previously helpers threw raw "HTTP 403" strings; now they throw mapped messages.)
    mockGetMy.mockRejectedValue(
      Object.assign(new Error("You don't have permission to do that for this org."), {
        name: "UserError",
        category: "forbidden",
        status: 403,
        raw: "",
      })
    )
    renderInbox()

    await waitFor(() =>
      expect(screen.getByText(/don't have permission/)).toBeInTheDocument(),
    )
    expect(screen.queryByText("You have no open assignments.")).not.toBeInTheDocument()
  })

  // AQU-366: guard against the list clipping instead of scrolling — see
  // ProjectsList.tsx for the full explanation of the flex chain this depends on.
  it("renders the list in a scrollable container (h-full + overflow-y-auto, no clipping)", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", scopeKind: "books", scopeLabel: "John", targetLang: "", deadline: null, note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
    ])
    renderInbox()
    await waitFor(() => expect(screen.getAllByText("John").length).toBeGreaterThan(0))

    const scrollContainer = screen.getByTestId("assigned-to-me-scroll")
    expect(scrollContainer.className).toMatch(/\bh-full\b/)
    expect(scrollContainer.className).toMatch(/\boverflow-y-auto\b/)
    expect(scrollContainer.className).not.toMatch(/overflow-hidden/)
  })
})
