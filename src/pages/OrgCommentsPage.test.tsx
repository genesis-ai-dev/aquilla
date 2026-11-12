// OrgCommentsPage behavior (AQU-1958). Pinned rules:
// - the surface is maintainer-gated: below the floor the list is replaced by a
//   lock state and the fan-out hook is never called for that viewer;
// - a guest org (project grant, no org membership) gets no org-wide surface;
// - each thread names its project, and jump-to-cell goes to THAT project;
// - a project whose comments failed to load is named, never silently dropped;
// - Export writes the visible list, project column included.

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { OrgCommentsPage } from "./OrgCommentsPage"
import type { UseOrgComments } from "@/hooks/useOrgComments"
import type { CommentRecord } from "@/lib/sync/comments-read-types"

vi.mock("@/components/org/OrgSidebar", () => ({ OrgSidebar: () => null }))
vi.mock("@/components/org/OrgBreadcrumb", () => ({ OrgBreadcrumb: () => null }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anastasia" }, loading: false }),
}))

const useActiveOrg = vi.fn()
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => useActiveOrg(),
}))

const useOrgComments = vi.fn()
vi.mock("@/hooks/useOrgComments", () => ({
  useOrgComments: (...args: unknown[]) => useOrgComments(...args),
}))

const downloadBlob = vi.fn()
vi.mock("@/lib/export/export-service", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}))

function orgContext(overrides: Record<string, unknown> = {}) {
  return {
    activeOrg: { id: 1, name: "BGP", role: { level: 600, name: "maintainer" } },
    activeOrgId: 1,
    activeGuestOrg: null,
    isAllOrgs: false,
    ...overrides,
  }
}

function comment(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "c1",
    projectId: "p-oromo",
    scopeKind: "cell",
    fileId: "f1",
    cellId: "cell-1",
    parentCommentId: null,
    body: "needs a footnote",
    resolved: false,
    authorId: "u-anastasia",
    authorLabel: "Anastasia",
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    cellRef: "GEN 1:1",
    ...overrides,
  }
}

function hookState(overrides: Partial<UseOrgComments> = {}): UseOrgComments {
  return {
    comments: [],
    projects: [
      { id: "p-oromo", name: "Oromo NT", files: [{ id: "f1", name: "Genesis" }] },
      { id: "p-marathi", name: "Marathi NT", files: [{ id: "f2", name: "Exodus" }] },
    ],
    isLoading: false,
    failedProjects: [],
    error: null,
    refresh: vi.fn(),
    ...overrides,
  }
}

/** Renders the current location so a jump can be asserted (CommentsPage's pattern). */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/orgs/1/comments"]}>
      <Routes>
        <Route path="/orgs/1/comments" element={<OrgCommentsPage />} />
        <Route path="/project/:id/editor/file/:fileId" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

function jumpedTo(): string {
  return screen.getByTestId("location").textContent ?? ""
}

describe("OrgCommentsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useActiveOrg.mockReturnValue(orgContext())
    useOrgComments.mockReturnValue(hookState())
  })

  it("lists comments from every permitted project, each labelled with its project", () => {
    useOrgComments.mockReturnValue(hookState({
      comments: [
        comment({ body: "oromo note" }),
        comment({ commentId: "c2", projectId: "p-marathi", fileId: "f2", body: "marathi note" }),
      ],
    }))
    renderPage()

    expect(screen.getByText("oromo note")).toBeInTheDocument()
    expect(screen.getByText("marathi note")).toBeInTheDocument()
    expect(screen.getByText("Oromo NT")).toBeInTheDocument()
    expect(screen.getByText("Marathi NT")).toBeInTheDocument()
  })

  it("does not read any comments for a viewer below maintainer", () => {
    useActiveOrg.mockReturnValue(orgContext({
      activeOrg: { id: 1, name: "BGP", role: { level: 400, name: "contributor" } },
    }))
    renderPage()

    expect(screen.getByText(/Only maintainers and owners/i)).toBeInTheDocument()
    expect(useOrgComments).not.toHaveBeenCalled()
  })

  it("offers no org-wide surface in a guest org", () => {
    useActiveOrg.mockReturnValue(orgContext({
      activeOrg: null,
      activeGuestOrg: { id: 1, name: "BGP" },
    }))
    renderPage()

    expect(useOrgComments).not.toHaveBeenCalled()
    expect(screen.getByText(/Choose an organization/i)).toBeInTheDocument()
  })

  it("jumps to the cell in the thread's own project", () => {
    useOrgComments.mockReturnValue(hookState({
      comments: [comment({ commentId: "c2", projectId: "p-marathi", fileId: "f2" })],
    }))
    renderPage()

    fireEvent.click(screen.getByText("Anastasia"))

    expect(jumpedTo()).toBe(
      "/project/p-marathi/editor/file/f2?cellId=cell-1&comments=1&commentId=c2",
    )
  })

  it("names the projects whose comments failed rather than showing a short list as complete", () => {
    useOrgComments.mockReturnValue(hookState({
      comments: [comment()],
      failedProjects: ["Marathi NT"],
    }))
    renderPage()

    expect(screen.getByText(/could not be loaded from: Marathi NT/i)).toBeInTheDocument()
    expect(screen.getByText("needs a footnote")).toBeInTheDocument()
  })

  it("exports the visible list with its project column", async () => {
    useOrgComments.mockReturnValue(hookState({
      comments: [
        comment({ body: "oromo note" }),
        comment({ commentId: "c2", projectId: "p-marathi", fileId: "f2", body: "marathi note" }),
      ],
    }))
    renderPage()

    fireEvent.click(screen.getByRole("button", { name: /Export as CSV/i }))

    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob] = downloadBlob.mock.calls[0] as [Blob, string]
    const csv = await blob.text()
    expect(csv).toContain("Oromo NT")
    expect(csv).toContain("Marathi NT")
    expect(csv).toContain("Genesis")
    expect(csv).toContain("oromo note")
    // Named for the org, like the project page's export is named for the project.
    expect(downloadBlob.mock.calls[0][1]).toBe("BGP-comments.csv")
  })

  it("narrows the list to the picked project", async () => {
    const user = userEvent.setup()
    useOrgComments.mockReturnValue(hookState({
      comments: [
        comment({ body: "oromo note" }),
        comment({ commentId: "c2", projectId: "p-marathi", fileId: "f2", body: "marathi note" }),
      ],
    }))
    renderPage()

    await user.click(screen.getByRole("button", { name: /^Filters$/i }))
    await user.click(screen.getByRole("combobox", { name: /^Project$/i }))
    await user.click(screen.getByRole("option", { name: "Marathi NT" }))

    await waitFor(() => {
      expect(screen.queryByText("oromo note")).not.toBeInTheDocument()
    })
    expect(screen.getByText("marathi note")).toBeInTheDocument()
  })
})
