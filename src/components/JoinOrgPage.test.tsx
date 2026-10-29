// AQU-471: the org-invite landing page must say which org, who invited you,
// and at what role — Biblica pilot feedback was that it named none of them.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { MemoryRouter, Routes, Route, Link } from "react-router-dom"
import { JoinOrgPage } from "./JoinOrgPage"
import { acceptOrgInvite } from "@/lib/frontier/orgs"
import { UserError } from "@/lib/errors/user-error"

vi.mock("@/lib/frontier/orgs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontier/orgs")>()),
  acceptOrgInvite: vi.fn(async () => ({
    orgId: 7,
    orgName: "Come and See",
    role: { level: 400, name: "contributor" },
  })),
}))

const preview = {
  orgId: 7, orgName: "Come and See", invitedBy: "Prabhu",
  role: { level: 400, name: "contributor" }, expiresAt: null, email: null,
}
const fetchMock = vi.fn<typeof fetch>()

let sessionValue: { session: { jwt: string } | null; loading: boolean } = {
  session: null,
  loading: false,
}
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => sessionValue }))

vi.mock("@/components/git-import/FrontierSignupForm", () => ({
  FrontierSignupForm: () => <button>do-signup</button>,
}))
vi.mock("@/components/git-import/FrontierLoginForm", () => ({
  FrontierLoginForm: () => <button>do-login</button>,
}))

function renderJoinOrg() {
  return render(
    <MemoryRouter initialEntries={["/join-org/tok"]}>
      <Routes>
        <Route path="/join-org/:token" element={<><Link to="/join-org/next">Next invitation</Link><JoinOrgPage /></>} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Fake JWT with an `exp` claim `secondsFromNow` out (isJwtExpired is real). */
function fakeJwt(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `h.${btoa(JSON.stringify({ exp }))}.s`
}

beforeEach(() => {
  sessionValue = { session: null, loading: false }
  vi.clearAllMocks()
  fetchMock.mockReset().mockImplementation(async () => Response.json(preview))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe("JoinOrgPage invite context (AQU-471)", () => {
  it("names the org, inviter, and role when signed out", async () => {
    renderJoinOrg()
    expect(await screen.findByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText(/invited by/i)).toBeInTheDocument()
    expect(screen.getByText("Prabhu")).toBeInTheDocument()
    expect(screen.getByText("contributor")).toBeInTheDocument()
    expect(screen.getByText("do-login")).toBeInTheDocument()
  })

  it("puts the org name in the card title", async () => {
    renderJoinOrg()
    expect(await screen.findByText(/Join Come and See/)).toBeInTheDocument()
  })

  it.each([false, true])("gates unavailable links before auth/accept (signed in: %s)", async (signedIn) => {
    sessionValue.session = signedIn ? { jwt: fakeJwt(3600) } : null
    // Run actual HTTP-result parsing through the page (not a mocked preview).
    for (const status of [404, 410]) {
      fetchMock.mockResolvedValueOnce(new Response(null, { status }))
      const view = renderJoinOrg()
      expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or no longer available/i)
      expect(screen.queryByText("do-login")).not.toBeInTheDocument()
      expect(screen.queryByText(/sign up/i)).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /accept invitation/i })).not.toBeInTheDocument()
      expect(acceptOrgInvite).not.toHaveBeenCalled()
      view.unmount()
    }
  })

  it.each(["server", "network"])("offers retry for a %s failure without marking the invite invalid", async (failure) => {
    if (failure === "server") fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    else fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    renderJoinOrg()
    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection/i)
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(await screen.findByText("do-login")).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("hides auth while pending and discards a stale preview when the token changes", async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    renderJoinOrg()
    expect(screen.getByRole("status")).toBeInTheDocument()
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("link", { name: "Next invitation" }))
    expect(await screen.findByText("Come and See")).toBeInTheDocument()
    await act(async () => resolve(Response.json({ ...preview, orgName: "Stale org" })))
    expect(screen.queryByText("Stale org")).not.toBeInTheDocument()
    expect(fetchMock.mock.calls[1][0]).toMatch(/invite-preview\/next$/)
  })

  it.each([404, 410])("still rejects an invitation invalidated after preview (HTTP %s)", async (status) => {
    sessionValue.session = { jwt: fakeJwt(3600) }
    vi.mocked(acceptOrgInvite).mockRejectedValueOnce(new UserError(status, ""))
    renderJoinOrg()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText("Can't join")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /accept invitation/i })).not.toBeInTheDocument()
  })

  it("shows the context on the signed-in confirm card and accepts on click", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    renderJoinOrg()
    expect(await screen.findByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText("Prabhu")).toBeInTheDocument()
    expect(acceptOrgInvite).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${sessionValue.session?.jwt}` }),
    }))
    fireEvent.click(screen.getByRole("button", { name: /accept invitation/i }))
    await waitFor(() => expect(acceptOrgInvite).toHaveBeenCalledWith(expect.any(String), "tok"))
  })

  it("re-prompts inline auth when the server rejects an unexpired JWT", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(acceptOrgInvite).mockRejectedValueOnce(new UserError(401, ""))
    renderJoinOrg()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText("do-login")).toBeInTheDocument()
    expect(screen.queryByText(/Couldn't join/)).not.toBeInTheDocument()
  })
})
