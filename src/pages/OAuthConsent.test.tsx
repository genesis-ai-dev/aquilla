import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OAuthConsent } from "./OAuthConsent"
import { leaveForClient, mcpOAuthCall } from "@/lib/sync/agent-connect"
import { pickSelectOption } from "@/test-utils/select"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "alice" }, loading: false }) }))
vi.mock("@/lib/sync/agent-connect", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/agent-connect")>()),
  mcpOAuthCall: vi.fn(),
  leaveForClient: vi.fn(),
}))
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
] }))

const api = vi.mocked(mcpOAuthCall)
const leave = vi.mocked(leaveForClient)
const QUERY = "response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json" +
  "&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcb&code_challenge=abc&code_challenge_method=S256&state=s1&scope=ask&junk=1"
const PARAMS = {
  response_type: "code", client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: "https://chatgpt.com/cb",
  code_challenge: "abc", code_challenge_method: "S256", state: "s1", scope: "ask",
}
const described = { clientName: "ChatGPT", clientHost: "chatgpt.com", redirectHost: "chatgpt.com", mode: "ask" as const }
const mount = () => render(<MemoryRouter initialEntries={[`/oauth/consent?${QUERY}`]}><OAuthConsent /></MemoryRouter>)

beforeEach(() => {
  api.mockReset(); leave.mockReset()
  api.mockResolvedValueOnce({ ok: true, data: described })
})

describe("OAuth consent for MCP hosts", () => {
  it("names the client by its verified domain and sends back only OAuth parameters", async () => {
    mount()
    expect(await screen.findByText("Connect ChatGPT to Aquilla")).toBeInTheDocument()
    expect(screen.getByText(/Request from chatgpt\.com/)).toBeInTheDocument()
    expect(screen.getByText(/return to chatgpt\.com/)).toBeInTheDocument()
    // Unknown query keys (`junk`) never reach the server.
    expect(api).toHaveBeenCalledWith("jwt", "request", PARAMS)
  })

  it("approves the chosen scope and mode, then leaves for the client with the code", async () => {
    mount()
    const allow = await screen.findByRole("button", { name: "Allow access" })
    // Nothing chosen yet: nothing to approve.
    expect(allow).toBeDisabled()
    await pickSelectOption("Project", "Project")
    fireEvent.click(screen.getByRole("radio", { name: /Act/ }))
    api.mockResolvedValueOnce({ ok: true, data: { redirect: "https://chatgpt.com/cb?code=c&state=s1" } })
    fireEvent.click(allow)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", {
      ...PARAMS, approve: true, mode: "act", project_id: "p",
    }))
    expect(leave).toHaveBeenCalledWith("https://chatgpt.com/cb?code=c&state=s1")
    expect(await screen.findByRole("status")).toHaveTextContent("Returning you to chatgpt.com")
  })

  it("can grant a whole organization", async () => {
    mount()
    await screen.findByRole("button", { name: "Allow access" })
    fireEvent.click(screen.getByRole("radio", { name: /whole organization/i }))
    api.mockResolvedValueOnce({ ok: true, data: { redirect: "https://chatgpt.com/cb?code=c" } })
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }))
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", expect.objectContaining({ org_id: "1" })))
  })

  it("denies without choosing a scope", async () => {
    mount()
    const deny = await screen.findByRole("button", { name: "Deny access" })
    api.mockResolvedValueOnce({ ok: true, data: { redirect: "https://chatgpt.com/cb?error=access_denied" } })
    fireEvent.click(deny)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", { ...PARAMS, approve: false }))
    await waitFor(() => expect(leave).toHaveBeenCalledWith("https://chatgpt.com/cb?error=access_denied"))
  })

  it("hands a request error back to a trusted client instead of showing consent", async () => {
    api.mockReset()
    api.mockResolvedValueOnce({ ok: false, status: 400, redirect: "https://chatgpt.com/cb?error=invalid_request" })
    mount()
    await waitFor(() => expect(leave).toHaveBeenCalledWith("https://chatgpt.com/cb?error=invalid_request"))
    expect(screen.queryByRole("button", { name: "Allow access" })).not.toBeInTheDocument()
  })

  it("refuses an untrusted request outright, with nowhere to send it", async () => {
    api.mockReset()
    api.mockResolvedValueOnce({ ok: false, status: 400 })
    mount()
    expect(await screen.findByRole("alert")).toHaveTextContent("not valid")
    expect(leave).not.toHaveBeenCalled()
    expect(screen.queryByRole("button", { name: "Allow access" })).not.toBeInTheDocument()
  })
})
