import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OAuthConsent } from "./OAuthConsent"
import { leaveForClient, mcpOAuthCall } from "@/lib/sync/agent-connect"

vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: { jwt: "jwt", username: "alice" }, loading: false }) }))
vi.mock("@/lib/sync/agent-connect", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/agent-connect")>()),
  mcpOAuthCall: vi.fn(),
  leaveForClient: vi.fn(),
}))
const api = vi.mocked(mcpOAuthCall)
const leave = vi.mocked(leaveForClient)
const QUERY = "response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json" +
  "&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcb&code_challenge=abc&code_challenge_method=S256&state=s1&scope=ask&junk=1"
const PARAMS = {
  response_type: "code", client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: "https://chatgpt.com/cb",
  code_challenge: "abc", code_challenge_method: "S256", state: "s1", scope: "ask",
}
const described = { clientName: "ChatGPT", clientHost: "chatgpt.com", redirectHost: "chatgpt.com", mode: "act" as const, organizations: [{ id: "1", name: "Come and See" }, { id: "2", name: "Second org" }] }
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

  it("approves selected organizations in fixed act mode and returns to the client", async () => {
    mount()
    const allow = await screen.findByRole("button", { name: "Allow access" })
    // Nothing chosen yet: nothing to approve.
    expect(allow).toBeDisabled()
    expect(screen.queryByRole("radio")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("checkbox", { name: "Come and See" }))
    api.mockResolvedValueOnce({ ok: true, data: { redirect: "https://chatgpt.com/cb?code=c&state=s1" } })
    fireEvent.click(allow)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", {
      ...PARAMS, approve: true, org_ids: ["1"],
    }))
    expect(leave).toHaveBeenCalledWith("https://chatgpt.com/cb?code=c&state=s1")
    expect(await screen.findByRole("status")).toHaveTextContent("Returning you to chatgpt.com")
  })

  it("selects all current organizations and can exclude an individual organization", async () => {
    mount()
    const allow = await screen.findByRole("button", { name: "Allow access" })
    fireEvent.click(screen.getByRole("checkbox", { name: "All current organizations" }))
    expect(screen.getByRole("checkbox", { name: "Come and See" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "Second org" })).toBeChecked()
    fireEvent.click(screen.getByRole("checkbox", { name: "Come and See" }))
    expect(screen.getByRole("checkbox", { name: "All current organizations" })).not.toBeChecked()
    api.mockResolvedValueOnce({ ok: true, data: { redirect: "https://chatgpt.com/cb?code=c" } })
    fireEvent.click(allow)
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("jwt", "decision", {
      ...PARAMS, approve: true, org_ids: ["2"],
    }))
  })

  it("cannot grant access when no organizations are eligible", async () => {
    api.mockReset()
    api.mockResolvedValueOnce({ ok: true, data: { ...described, organizations: [] } })
    mount()
    expect(await screen.findByRole("button", { name: "Allow access" })).toBeDisabled()
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
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
