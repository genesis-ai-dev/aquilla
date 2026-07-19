// AQU-471: the org-invite landing page must say which org, who invited you,
// and at what role — Biblica pilot feedback was that it named none of them.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { JoinOrgPage } from "./JoinOrgPage"
import { acceptOrgInvite, previewOrgInvite } from "@/lib/frontier/orgs"

const navigate = vi.fn()
vi.mock("react-router-dom", async (i) => ({
  ...(await i<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

vi.mock("@/lib/frontier/orgs", () => ({
  acceptOrgInvite: vi.fn(async () => ({
    orgId: 7,
    orgName: "Come and See",
    role: { level: 400, name: "contributor" },
  })),
  previewOrgInvite: vi.fn(async () => ({
    orgId: 7,
    orgName: "Come and See",
    invitedBy: "Prabhu",
    role: { level: 400, name: "contributor" },
    expiresAt: null,
    email: null,
  })),
}))

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
        <Route path="/join-org/:token" element={<JoinOrgPage />} />
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
})

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

  it("falls back to the generic copy when the preview fails", async () => {
    vi.mocked(previewOrgInvite).mockResolvedValueOnce(null)
    renderJoinOrg()
    expect(
      await screen.findByText(/You've been invited to join an organization on Aquilla/),
    ).toBeInTheDocument()
    // Accept path stays available: signed-out users still get inline auth.
    expect(screen.getByText("do-login")).toBeInTheDocument()
  })

  it("shows the context on the signed-in confirm card and accepts on click", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    renderJoinOrg()
    expect(await screen.findByText("Come and See")).toBeInTheDocument()
    expect(screen.getByText("Prabhu")).toBeInTheDocument()
    expect(acceptOrgInvite).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /accept invitation/i }))
    await waitFor(() => expect(acceptOrgInvite).toHaveBeenCalledWith(expect.any(String), "tok"))
  })
})
