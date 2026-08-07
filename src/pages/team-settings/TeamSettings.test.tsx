import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { OrgProvider } from "@/context/OrgContext"
import { TeamSettingsIndex } from "@/pages/team-settings/TeamSettingsIndex"
import { toast } from "@/components/ui/toast"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "jwt", username: "wendi", createdAt: "x" },
    loading: false,
  }),
}))

vi.mock("@/components/ui/toast", () => ({
  toast: { add: vi.fn(), close: vi.fn(), update: vi.fn(), promise: vi.fn() },
}))

const listMyOrgs = vi.fn()
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...a: unknown[]) => listMyOrgs(...a),
}))

const getTeam = vi.fn()
const updateTeam = vi.fn()
const deleteTeam = vi.fn()
vi.mock("@/lib/frontier/teams", () => ({
  getTeam: (...a: unknown[]) => getTeam(...a),
  updateTeam: (...a: unknown[]) => updateTeam(...a),
  deleteTeam: (...a: unknown[]) => deleteTeam(...a),
}))

function renderSettings(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <OrgProvider>
          <Routes>
            <Route path="/orgs/:orgId/teams/:groupId/settings" element={<TeamSettingsIndex />} />
            <Route path="/orgs/:orgId/teams" element={<div>Teams list</div>} />
          </Routes>
        </OrgProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 700, name: "owner" } }])
  getTeam.mockResolvedValue({
    id: 10,
    name: "WA",
    description: "West Africa",
    members: [],
    projects: [],
  })
  updateTeam.mockReset()
  updateTeam.mockResolvedValue({ id: 10, name: "WA2", description: "Updated" })
  deleteTeam.mockResolvedValue(undefined)
  vi.mocked(toast.add).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("TeamSettingsIndex", () => {
  it("shows identity fields and a Danger zone delete control for admins", async () => {
    renderSettings("/orgs/1/teams/10/settings")
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /team settings/i })).toBeInTheDocument(),
    )
    expect(screen.getByDisplayValue("WA")).toBeInTheDocument()
    expect(screen.getByDisplayValue("West Africa")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /delete team/i })).toBeInTheDocument()
  })

  it("saves name and description on blur", async () => {
    const { fireEvent } = await import("@testing-library/react")
    renderSettings("/orgs/1/teams/10/settings")
    await waitFor(() => expect(screen.getByDisplayValue("WA")).toBeInTheDocument())
    const nameInput = screen.getByLabelText(/^team name$/i)
    const descInput = screen.getByLabelText(/^description$/i)

    updateTeam.mockResolvedValueOnce({ id: 10, name: "WA2", description: "West Africa" })
    fireEvent.change(nameInput, { target: { value: "WA2" } })
    fireEvent.blur(nameInput)
    await waitFor(() =>
      expect(updateTeam).toHaveBeenCalledWith("jwt", 1, 10, { name: "WA2" }),
    )
    expect(toast.add).toHaveBeenCalledWith({
      type: "success",
      title: "Team name updated",
    })

    updateTeam.mockClear()
    vi.mocked(toast.add).mockClear()
    updateTeam.mockResolvedValueOnce({ id: 10, name: "WA2", description: "Updated" })
    fireEvent.change(descInput, { target: { value: "Updated" } })
    fireEvent.blur(descInput)
    await waitFor(() =>
      expect(updateTeam).toHaveBeenCalledWith("jwt", 1, 10, { description: "Updated" }),
    )
    expect(toast.add).toHaveBeenCalledWith({
      type: "success",
      title: "Description updated",
    })
  })

  it("does not save when the blurred value is unchanged", async () => {
    const { fireEvent } = await import("@testing-library/react")
    renderSettings("/orgs/1/teams/10/settings")
    await waitFor(() => expect(screen.getByDisplayValue("WA")).toBeInTheDocument())
    fireEvent.blur(screen.getByLabelText(/^team name$/i))
    fireEvent.blur(screen.getByLabelText(/^description$/i))
    expect(updateTeam).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("deletes the team after confirm and returns to the teams list", async () => {
    renderSettings("/orgs/1/teams/10/settings")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /delete team/i })).toBeInTheDocument(),
    )
    await act(async () => {
      screen.getByRole("button", { name: /delete team/i }).click()
    })
    await act(async () => {
      screen.getByRole("button", { name: /confirm/i }).click()
    })
    await waitFor(() => expect(deleteTeam).toHaveBeenCalledWith("jwt", 1, 10))
    await waitFor(() => expect(screen.getByText("Teams list")).toBeInTheDocument())
  })

  it("hides Danger zone for non-admins", async () => {
    listMyOrgs.mockResolvedValue([{ id: 1, name: "CAS", role: { level: 100, name: "viewer" } }])
    renderSettings("/orgs/1/teams/10/settings")
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /team settings/i })).toBeInTheDocument(),
    )
    expect(screen.queryByRole("button", { name: /delete team/i })).toBeNull()
  })
})
