// AQU-471: the org-invite landing page must say which org, who invited you,
// and at what role — Biblica pilot feedback was that it named none of them.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { JoinOrgPage } from "./JoinOrgPage"
import { acceptOrgInvite, previewOrgInvite } from "@/lib/frontier/orgs"
import { UserError } from "@/lib/errors/user-error"
import { requestPasswordReset } from "@/lib/frontier/auth"

vi.mock("@/lib/frontier/auth", async (original) => ({
  ...(await original<typeof import("@/lib/frontier/auth")>()),
  requestPasswordReset: vi.fn(async () => {}),
}))

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
  FrontierLoginForm: ({ onForgotPassword }: { onForgotPassword?: () => void }) => (
    <><button>do-login</button><button onClick={onForgotPassword}>Forgot password?</button></>
  ),
}))

function renderJoinOrg(token = "tok") {
  return render(
    <MemoryRouter initialEntries={[`/join-org/${token}`]}>
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
  it("offers recovery and keeps the invitation when requesting a reset or returning to login", async () => {
    renderJoinOrg("invite-token")
    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }))
    expect(screen.getByText("Come and See")).toBeInTheDocument()
    expect(screen.queryByText("Need an account? Sign up")).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } })
    fireEvent.submit(document.getElementById("forgot-password-form")!)
    await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledWith(
      "alice@example.com", "/join-org/invite-token",
    ))
    fireEvent.click(await screen.findByRole("button", { name: /back to login/i }))
    expect(screen.getByText("do-login")).toBeInTheDocument()
    expect(acceptOrgInvite).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

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

  it("re-prompts inline auth when the server rejects an unexpired JWT", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(acceptOrgInvite).mockRejectedValueOnce(new UserError(401, ""))
    renderJoinOrg()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText("do-login")).toBeInTheDocument()
    expect(screen.queryByText(/Couldn't join/)).not.toBeInTheDocument()
  })
})
