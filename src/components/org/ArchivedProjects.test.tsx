import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ArchivedProjects } from "./ArchivedProjects"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

const fetchArchivedProjects = vi.fn()
vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchArchivedProjects: (...a: unknown[]) => fetchArchivedProjects(...a),
  fetchAccessibleProjects: vi.fn(async () => []),
}))

const unarchiveProjectRemote = vi.fn()
vi.mock("@/lib/sync/archive", () => ({
  unarchiveProjectRemote: (...a: unknown[]) => unarchiveProjectRemote(...a),
}))

function renderArchived() {
  return render(
    <MemoryRouter><OrgProvider><ArchivedProjects /></OrgProvider></MemoryRouter>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

describe("ArchivedProjects", () => {
  it("shows explicit progress while archived projects are unresolved", async () => {
    fetchArchivedProjects.mockImplementationOnce(() => new Promise(() => {}))
    renderArchived()

    expect(
      await screen.findByRole("status", { name: "Loading archived projects" }),
    ).toHaveAttribute("aria-busy", "true")
  })

  it("lists archived projects in a table and restores on click", async () => {
    fetchArchivedProjects.mockResolvedValue([
      {
        id: "old",
        name: "Old Project",
        archivedAt: "2026-01-15T12:00:00.000Z",
        files: [{ id: "f1", name: "a.usfm", type: "usfm", cellCount: 1 }],
        role: { level: 700, name: "owner", source: "org" },
      },
    ])
    unarchiveProjectRemote.mockResolvedValue({ kind: "restored" })
    renderArchived()

    await waitFor(() => expect(fetchArchivedProjects).toHaveBeenCalledWith("jwt", 1))
    expect(await screen.findByTestId("org-archived-projects-table")).toBeInTheDocument()
    expect(screen.getByText("Old Project")).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /Project/i })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: /Archived/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "More actions for Old Project" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }))
    await waitFor(() => expect(unarchiveProjectRemote).toHaveBeenCalledWith("old", "jwt"))
  })

  it("restores from the row right-click context menu", async () => {
    fetchArchivedProjects.mockResolvedValue([
      {
        id: "old",
        name: "Old Project",
        archivedAt: "2026-01-15T12:00:00.000Z",
        files: [],
        role: { level: 700, name: "owner", source: "org" },
      },
    ])
    unarchiveProjectRemote.mockResolvedValue({ kind: "restored" })
    renderArchived()

    const row = (await screen.findByText("Old Project")).closest("tr")
    expect(row).toBeTruthy()
    fireEvent.contextMenu(row!)
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore" }))
    await waitFor(() => expect(unarchiveProjectRemote).toHaveBeenCalledWith("old", "jwt"))
  })

  it("shows an empty state when there are no archived projects", async () => {
    fetchArchivedProjects.mockResolvedValue([])
    renderArchived()

    await waitFor(() => expect(fetchArchivedProjects).toHaveBeenCalledWith("jwt", 1))
    expect(await screen.findByText("No archived projects.")).toBeInTheDocument()
    const panel = screen.getByTestId("org-archived-projects-table")
    expect(panel).toHaveClass("border", "bg-card")
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  // AQU-366: guard against the list clipping instead of scrolling — see
  // ProjectsList.tsx for the full explanation of the flex chain this depends on.
  it("renders the list in a scrollable container (h-full + overflow-y-auto, no clipping)", async () => {
    fetchArchivedProjects.mockResolvedValue([
      { id: "old", name: "Old Project", role: { level: 700, name: "owner", source: "org" } },
    ])
    renderArchived()
    await screen.findByText("Old Project")

    const scrollContainer = screen.getByTestId("archived-projects-scroll")
    expect(scrollContainer.className).toMatch(/\bh-full\b/)
    expect(scrollContainer.className).toMatch(/\boverflow-y-auto\b/)
    expect(scrollContainer.className).not.toMatch(/overflow-hidden/)
  })
})
