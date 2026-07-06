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
  it("lists archived projects and restores on click", async () => {
    fetchArchivedProjects.mockResolvedValue([
      { id: "old", name: "Old Project", role: { level: 700, name: "owner", source: "org" } },
    ])
    unarchiveProjectRemote.mockResolvedValue({ kind: "restored" })
    renderArchived()

    await waitFor(() => expect(fetchArchivedProjects).toHaveBeenCalledWith("jwt", 1))
    expect(await screen.findByText("Old Project")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))
    await waitFor(() => expect(unarchiveProjectRemote).toHaveBeenCalledWith("old", "jwt"))
  })

  it("shows an empty state when there are no archived projects", async () => {
    fetchArchivedProjects.mockResolvedValue([])
    renderArchived()

    await waitFor(() => expect(fetchArchivedProjects).toHaveBeenCalledWith("jwt", 1))
    expect(screen.getByText("No archived projects.")).toBeInTheDocument()
  })
})
