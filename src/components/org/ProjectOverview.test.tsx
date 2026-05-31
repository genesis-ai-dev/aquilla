import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { ProjectOverview } from "./ProjectOverview"
import type { ProjectRecord } from "@/lib/parsers/types"

const navigate = vi.fn()
vi.mock("react-router-dom", async (importActual) => {
  const actual = await importActual<typeof import("react-router-dom")>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
}))
vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))

const useProject = vi.fn()
const refresh = vi.fn()
vi.mock("@/hooks/useProject", () => ({ useProject: (...a: unknown[]) => useProject(...a) }))

const archiveProjectRemote = vi.fn()
const unarchiveProjectRemote = vi.fn()
vi.mock("@/lib/sync/archive", () => ({
  archiveProjectRemote: (...a: unknown[]) => archiveProjectRemote(...a),
  unarchiveProjectRemote: (...a: unknown[]) => unarchiveProjectRemote(...a),
}))

function projectRecord(over: Partial<ProjectRecord> & { level: number; deletedAt?: string }): ProjectRecord {
  const { level, deletedAt, ...rest } = over
  return {
    id: "p1",
    name: "John",
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: "2026-01-01",
    files: [],
    members: [],
    syncRole: { level, name: "x", source: "org", fetchedAt: "2026-01-01" },
    ...(deletedAt ? { deletedAt } : {}),
    ...rest,
  } as ProjectRecord
}

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1"]}>
      <OrgProvider>
        <Routes><Route path="/projects/:id" element={<ProjectOverview />} /></Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

describe("ProjectOverview archive/restore", () => {
  it("owner sees Archive; clicking archives and returns to /projects", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700 }), status: "ready", refresh })
    archiveProjectRemote.mockResolvedValue({ kind: "archived", archivedAt: "now", archivedBy: { id: 1, username: "wendi" } })
    renderOverview()

    const btn = await screen.findByRole("button", { name: "Archive" })
    fireEvent.click(btn)

    await waitFor(() => expect(archiveProjectRemote).toHaveBeenCalledWith("p1", "jwt"))
    expect(navigate).toHaveBeenCalledWith("/projects")
  })

  it("non-owner does not see the Archive button", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 100 }), status: "ready", refresh })
    renderOverview()

    await screen.findByRole("button", { name: "Open project" })
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument()
  })

  it("owner of an archived project sees Restore + Archived badge", async () => {
    useProject.mockReturnValue({ project: projectRecord({ level: 700, deletedAt: "2026-05-01" }), status: "ready", refresh })
    unarchiveProjectRemote.mockResolvedValue({ kind: "restored" })
    renderOverview()

    expect(await screen.findByText("Archived")).toBeInTheDocument()
    const btn = screen.getByRole("button", { name: "Restore" })
    fireEvent.click(btn)

    await waitFor(() => expect(unarchiveProjectRemote).toHaveBeenCalledWith("p1", "jwt"))
  })
})
