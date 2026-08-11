import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { AssignedToMe } from "./AssignedToMe"

const navigate = vi.fn()
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom")
  return { ...actual, useNavigate: () => navigate }
})

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
  navigate.mockClear()
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
  it("shows a loading skeleton while assignments are unresolved", async () => {
    mockGetMy.mockImplementationOnce(() => new Promise(() => {}))
    renderInbox()

    // Match TeamsList: pulse card shell while the org inbox loads.
    await waitFor(() => expect(document.querySelector(".animate-pulse")).toBeTruthy())
  })

  it("aggregates the caller's open assignments across projects with progress", async () => {
    // One org-level request (GET /orgs/:orgId/assignments/mine) replaces the
    // old per-project fan-out — rows arrive with projectName attached.
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", fileName: "01-JHN.usfm", scopeKind: "books", scopeLabel: "John", targetLang: "", deadline: "2026-06-30", note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", fileName: "02-MRK.usfm", scopeKind: "chapters", scopeLabel: "Mark · MRK 1", targetLang: "", deadline: null, note: null, cellsTotal: 5, cellsDone: 5, createdAt: 100 },
    ])
    renderInbox()

    await waitFor(() => expect(screen.getByTestId("org-assigned-table")).toBeInTheDocument())
    expect(screen.getByText("Mark · MRK 1")).toBeInTheDocument()
    expect(screen.getByText("01-JHN.usfm")).toBeInTheDocument()
    expect(screen.getByText("02-MRK.usfm")).toBeInTheDocument()
    expect(screen.getByText("4/10 cells · 40%")).toBeInTheDocument()
    expect(screen.getByText("5/5 cells · 100%")).toBeInTheDocument()
    // Admin-console DateTooltip short calendar label (not raw ISO).
    expect(screen.getByText(fmtShortCalendarDate("2026-06-30"))).toBeInTheDocument()
    expect(mockGetMy).toHaveBeenCalledWith("jwt", 1)
  })

  // AQU-538 (§3.5): a lane-pinned assignment shows a lane chip and deep-links
  // into the project at that lane (?lane=<tag>); the default lane ('') does not.
  // AQU-690: when fileId is present, open that file in the editor.
  it("renders a lane chip and navigates with ?lane= for a lane-pinned assignment", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", fileName: "01-JHN.usfm", scopeKind: "books", scopeLabel: "John scope", targetLang: "es", deadline: null, note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", fileName: "02-MRK.usfm", scopeKind: "books", scopeLabel: "Mark scope", targetLang: "", deadline: null, note: null, cellsTotal: 5, cellsDone: 1, createdAt: 100 },
    ])
    renderInbox()

    await waitFor(() => expect(screen.getByText("John scope")).toBeInTheDocument())
    // The lane chip renders the tag for the pinned lane only.
    expect(screen.getByText("es")).toBeInTheDocument()

    fireEvent.click(screen.getByText("John scope"))
    expect(navigate).toHaveBeenCalledWith("/project/pa/editor/file/f1?lane=es")

    fireEvent.click(screen.getByText("Mark scope"))
    expect(navigate).toHaveBeenCalledWith("/project/pb/editor/file/f2")
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
    await waitFor(() => expect(screen.getByTestId("org-assigned-table")).toBeInTheDocument())

    const scrollContainer = screen.getByTestId("assigned-to-me-scroll")
    expect(scrollContainer.className).toMatch(/\bh-full\b/)
    expect(scrollContainer.className).toMatch(/\boverflow-y-auto\b/)
    expect(scrollContainer.className).not.toMatch(/overflow-hidden/)
  })

  it("search narrows the table by scope, project, or file name", async () => {
    mockGetMy.mockResolvedValue([
      { assignmentId: "a1", projectId: "pa", projectName: "John", fileId: "f1", fileName: "01-JHN.usfm", scopeKind: "books", scopeLabel: "John scope", targetLang: "", deadline: null, note: null, cellsTotal: 10, cellsDone: 4, createdAt: 200 },
      { assignmentId: "a2", projectId: "pb", projectName: "Mark", fileId: "f2", fileName: "02-MRK.usfm", scopeKind: "chapters", scopeLabel: "Mark · MRK 1", targetLang: "", deadline: null, note: null, cellsTotal: 5, cellsDone: 1, createdAt: 100 },
    ])
    renderInbox()
    await waitFor(() => expect(screen.getByText("John scope")).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText("Search assignments…"), { target: { value: "MRK" } })
    await waitFor(() => expect(screen.getByText("Mark · MRK 1")).toBeInTheDocument())
    expect(screen.queryByText("John scope")).toBeNull()

    fireEvent.change(screen.getByPlaceholderText("Search assignments…"), { target: { value: "01-JHN" } })
    await waitFor(() => expect(screen.getByText("John scope")).toBeInTheDocument())
    expect(screen.queryByText("Mark · MRK 1")).toBeNull()
  })
})
