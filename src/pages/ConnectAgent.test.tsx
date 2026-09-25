import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { ConnectAgent } from "./ConnectAgent"
import { connectionRequest } from "@/lib/sync/agent-connect"
import { pickSelectOption } from "@/test-utils/select"
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "alice" }, loading: false }) }))
vi.mock("@/lib/sync/agent-connect", () => ({ connectionRequest: vi.fn() }))
// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: async () => ({ ok: true, projects: [
    { id: "p", name: "Project", role: { level: 700 } },
    { id: "helper", name: "Contributor project", role: { level: 400 } },
  ] }),
}))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: async () => [
  { id: 1, name: "Come and See", role: { level: 700 } },
  { id: 2, name: "Guest org", role: { level: 100 } },
] }))
const api = vi.mocked(connectionRequest)
const request = { agentName: "My agent", mode: "ask", requestedProjectId: "p", expiresAt: "2030-01-01", tokenExpiresIn: 2592000 }
const mount = () => render(<MemoryRouter initialEntries={["/connect-agent#user_code=ABCD-EFGH"]}><ConnectAgent /></MemoryRouter>)
const review = async () => {
  mount()
  fireEvent.click(screen.getByRole("button", { name: "Review request" }))
  return await screen.findByRole("button", { name: "Authorize agent" })
}
beforeEach(() => { api.mockReset(); api.mockResolvedValue(request) })
describe("agent consent", () => {
  it("requires explicit code confirmation and sends consent without receiving credentials", async () => {
    const authorize = await review()
    expect(authorize).toBeDisabled()
    // The pinned project is shown as text, not a picker.
    expect(screen.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument()
    expect(screen.getByText(/not verified/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(authorize).toBeEnabled()
    api.mockResolvedValueOnce({ status: "approved" })
    fireEvent.click(authorize)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", { user_code: "ABCD-EFGH", approve: true, mode: "ask", project_id: "p", code_confirmed: true }))
    expect(await screen.findByRole("status")).toHaveTextContent("Access approved")
  })
  it("allows denial without choosing a project or confirming the code", async () => {
    mount(); fireEvent.click(screen.getByRole("button", { name: "Review request" }))
    fireEvent.click(await screen.findByRole("button", { name: "Deny access" }))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", { user_code: "ABCD-EFGH", approve: false }))
    expect(await screen.findByRole("status")).toHaveTextContent("Access denied")
  })
  it("shows expired or invalid request errors without offering authorization", async () => {
    api.mockRejectedValueOnce(new Error("400")); mount()
    fireEvent.click(screen.getByRole("button", { name: "Review request" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("expired")
    expect(screen.queryByRole("button", { name: "Authorize agent" })).not.toBeInTheDocument()
  })
  it("grants the mode the human picked, not the one the agent asked for", async () => {
    // The agent's request is a default. Approving sends what is on screen.
    const authorize = await review()
    fireEvent.click(screen.getByRole("radio", { name: /Act/ }))
    expect(screen.getByText(/asked for ask mode/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox"))
    api.mockResolvedValueOnce({ status: "approved" })
    fireEvent.click(authorize)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", expect.objectContaining({ mode: "act", project_id: "p" })))
  })
  it("keeps a requested project pinned, with no org escape hatch", async () => {
    await review()
    expect(screen.getByText(/asked for this specific project/)).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: /whole organization/i })).not.toBeInTheDocument()
  })
  it("offers org scope when the agent pinned nothing, listing only eligible orgs", async () => {
    api.mockResolvedValue({ ...request, requestedProjectId: null })
    const authorize = await review()
    // Nothing is selected yet, so there is nothing to approve.
    fireEvent.click(screen.getByRole("checkbox"))
    expect(authorize).toBeDisabled()
    fireEvent.click(screen.getByRole("radio", { name: /whole organization/i }))
    // The viewer-level org is below the contributor floor and is not offered.
    fireEvent.click(screen.getByRole("combobox", { name: "Organization" }))
    expect(screen.queryByRole("option", { name: "Guest org" })).not.toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull())
    await pickSelectOption("Organization", "Come and See")
    api.mockResolvedValueOnce({ status: "approved" })
    fireEvent.click(authorize)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", { user_code: "ABCD-EFGH", approve: true, mode: "ask", org_id: "1", code_confirmed: true }))
  })
  it("drops a selection that switching to act mode makes ineligible", async () => {
    // A contributor-level project is fine for ask and not for act; the button
    // must go back to disabled rather than submit a scope the server refuses.
    api.mockResolvedValue({ ...request, requestedProjectId: null })
    const authorize = await review()
    fireEvent.click(screen.getByRole("checkbox"))
    await pickSelectOption("Project", "Contributor project")
    await waitFor(() => expect(authorize).toBeEnabled())
    fireEvent.click(screen.getByRole("radio", { name: /Act/ }))
    await waitFor(() => expect(authorize).toBeDisabled())
  })
})
