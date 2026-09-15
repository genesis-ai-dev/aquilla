import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { ConnectAgent } from "./ConnectAgent"
import { connectionRequest } from "@/lib/sync/agent-connect"
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "alice" }, loading: false }) }))
vi.mock("@/lib/sync/agent-connect", () => ({ connectionRequest: vi.fn() }))
vi.mock("@/lib/sync/cloud-projects", () => ({ fetchAccessibleProjectsResult: async () => ({ ok: true, projects: [{ id: "p", name: "Project", role: { level: 700 } }] }) }))
const api = vi.mocked(connectionRequest)
const request = { agentName: "My agent", mode: "ask", requestedProjectId: "p", expiresAt: "2030-01-01", tokenExpiresIn: 2592000 }
const mount = () => render(<MemoryRouter initialEntries={["/connect-agent#user_code=ABCD-EFGH"]}><ConnectAgent /></MemoryRouter>)
beforeEach(() => { api.mockReset(); api.mockResolvedValue(request) })
describe("agent consent", () => {
  it("requires explicit code confirmation and sends consent without receiving credentials", async () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Review request" }))
    const authorize = await screen.findByRole("button", { name: "Authorize agent" })
    expect(authorize).toBeDisabled()
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Project")
    expect(screen.getByText(/not verified/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(authorize).toBeEnabled()
    api.mockResolvedValueOnce({ status: "approved" })
    fireEvent.click(authorize)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", { user_code: "ABCD-EFGH", approve: true, project_id: "p", code_confirmed: true }))
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
})
