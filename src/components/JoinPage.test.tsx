import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { JoinPage, InviteSummary } from "./JoinPage"
import { acceptServerInvite, previewMultiInvite, acceptMultiInvite, previewServerInvite } from "@/lib/sync/invites"

const navigate = vi.fn()
vi.mock("react-router-dom", async (i) => ({
  ...(await i<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

vi.mock("@/lib/sync/invites", () => ({
  acceptServerInvite: vi.fn(async () => ({ ok: true, data: { projectId: "p1" } })),
  previewServerInvite: vi.fn(async () => ({ ok: true, data: { projectName: "John", role: { level: 400, name: "contributor" }, email: null } })),
  previewMultiInvite: vi.fn(async () => ({ ok: false, reason: "invalid" })),
  acceptMultiInvite: vi.fn(async () => ({ ok: false, reason: "invalid" })),
}))

let sessionValue: { session: { jwt: string } | null; loading: boolean } = { session: null, loading: false }
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => sessionValue }))

vi.mock("@/components/git-import/FrontierSignupForm", () => ({
  FrontierSignupForm: ({ onSuccess, initialEmail }: { onSuccess: () => void; initialEmail?: string | null }) => (
    <div>
      <span data-testid="signup-initial-email">{initialEmail ?? ""}</span>
      <button onClick={onSuccess}>do-signup</button>
    </div>
  ),
}))
vi.mock("@/components/git-import/FrontierLoginForm", () => ({
  FrontierLoginForm: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>do-login</button>,
}))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({
  FrontierForgotPasswordForm: () => <div />,
}))

function renderJoin() {
  return render(
    <MemoryRouter initialEntries={["/join/tok"]}>
      <Routes><Route path="/join/:token" element={<JoinPage />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  sessionValue = { session: null, loading: false }
  vi.clearAllMocks()
})

describe("JoinPage inline auth", () => {
  it("shows inline auth (no bounce to /) when signed out", async () => {
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(screen.getByText("do-login")).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalledWith("/")
  })

  // AQU-335: signed-in users must NOT be auto-joined on link-open — access is
  // granted only on an explicit "Accept invitation" click, so there's always
  // a user-facing signal that membership just changed (spec
  // join-via-invite-link Step 2 confirmation).
  it("shows a confirmation card when signed in and redeems only on Accept", async () => {
    sessionValue = { session: { jwt: "jwt" }, loading: false }
    renderJoin()
    const accept = await screen.findByRole("button", { name: /accept invitation/i })
    // Preview rendered, nothing redeemed yet.
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(acceptServerInvite).not.toHaveBeenCalled()
    expect(acceptMultiInvite).not.toHaveBeenCalled()

    fireEvent.click(accept)
    await waitFor(() => expect(acceptServerInvite).toHaveBeenCalledWith("jwt", "tok"))
    expect(navigate).toHaveBeenCalledWith("/project/p1/editor")
  })

  // AQU-471: the landing page must answer "who invited me, to which workspace"
  // (Biblica pilot feedback) — not just name the project.
  it("shows the inviter and workspace when the preview carries them", async () => {
    vi.mocked(previewServerInvite).mockResolvedValueOnce({
      ok: true,
      data: {
        projectId: "p1",
        projectName: "Kilisusu NT",
        orgName: "Come and See",
        invitedBy: "Prabhu",
        role: { level: 400, name: "contributor" },
        expiresAt: null,
        email: null,
      },
    })
    renderJoin()
    expect(await screen.findByText("Kilisusu NT")).toBeInTheDocument()
    expect(screen.getByText(/in Come and See/)).toBeInTheDocument()
    expect(screen.getByText(/invited by/i)).toBeInTheDocument()
    expect(screen.getByText("Prabhu")).toBeInTheDocument()
  })

  it("omits the inviter/workspace lines when the server predates them", async () => {
    // Default previewServerInvite mock has no invitedBy/orgName fields.
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(screen.queryByText(/invited by/i)).not.toBeInTheDocument()
  })

  it("shows a multi-project preview (N projects) when signed out", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({
      ok: true,
      data: {
        token: "tok",
        role: { level: 400, name: "contributor" },
        expiresAt: null,
        projects: [
          { projectId: "pa", projectName: "John", archived: false },
          { projectId: "pb", projectName: "Mark", archived: false },
        ],
      },
    })
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(screen.getByText("Mark")).toBeInTheDocument()
    expect(screen.getByText("do-login")).toBeInTheDocument() // inline auth still shows
  })

  it("redeems a multi-project token via acceptMultiInvite after Accept", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({
      ok: true,
      data: {
        token: "tok",
        role: { level: 400, name: "contributor" },
        expiresAt: null,
        projects: [{ projectId: "pa", projectName: "John", archived: false }],
      },
    })
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({
      ok: true,
      data: {
        token: "tok",
        accepted: [{ projectId: "pa", role: 400 }, { projectId: "pb", role: 400 }],
      },
    })
    sessionValue = { session: { jwt: "jwt" }, loading: false }
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    await waitFor(() => expect(acceptMultiInvite).toHaveBeenCalledWith("jwt", "tok"))
    expect(navigate).toHaveBeenCalledWith("/project/pa/editor") // first accepted project
  })
})

/** Build a fake JWT whose `exp` claim is `secondsFromNow` seconds out. */
function fakeJwt(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `h.${btoa(JSON.stringify({ exp }))}.s`
}

// AQU-338: the cold-signup form must know what the invite's email means —
// prefilled from a bound invite, or explicitly free-form for an anyone-with-link
// invite — instead of silently rendering an empty field.
describe("JoinPage AQU-338: invite email prefill on cold signup", () => {
  it("prefills the signup email from an email-bound invite and offers to change it", async () => {
    vi.mocked(previewServerInvite).mockResolvedValueOnce({
      ok: true,
      data: { projectId: "p1", projectName: "John", role: { level: 400, name: "contributor" }, expiresAt: null, email: "invitee@example.com" },
    })
    renderJoin()
    await screen.findByText("John") // preview resolved
    fireEvent.click(screen.getByText("Create an account"))
    expect(screen.getByTestId("signup-initial-email")).toHaveTextContent("invitee@example.com")
    expect(screen.getByText(/pre-filled the email from your invitation/i)).toBeInTheDocument()
  })

  it("leaves the email empty and explains the anyone-with-link case when the invite has no bound email", async () => {
    vi.mocked(previewServerInvite).mockResolvedValueOnce({
      ok: true,
      data: { projectId: "p1", projectName: "John", role: { level: 400, name: "contributor" }, expiresAt: null, email: null },
    })
    renderJoin()
    await screen.findByText("John")
    fireEvent.click(screen.getByText("Create an account"))
    expect(screen.getByTestId("signup-initial-email").textContent).toBe("")
    expect(screen.getByText(/isn't bound to an email/i)).toBeInTheDocument()
  })
})

describe("JoinPage expired session", () => {
  // Regression: an expired stored JWT used to land the user on the confirm
  // card; clicking Accept 401'd and surfaced as "this invite link is no longer
  // valid" — a dead-invite error for what was really an auth-expiry, with no
  // way to recover. An expired session must instead re-prompt login while
  // making clear the invitation itself is still good.
  it("shows inline login (not Accept, not a dead-invite error) when the session JWT is expired", async () => {
    sessionValue = { session: { jwt: fakeJwt(-60) }, loading: false }
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument() // preview still loads
    expect(screen.getByText("do-login")).toBeInTheDocument()
    expect(screen.getByText(/your session expired/i)).toBeInTheDocument()
    expect(screen.getByText(/invitation is still valid/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /accept invitation/i })).not.toBeInTheDocument()
    expect(screen.queryByText("This invite link is no longer valid")).not.toBeInTheDocument()
    expect(acceptServerInvite).not.toHaveBeenCalled()
  })

  it("shows the confirm card (not login) when the session JWT is still valid", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    renderJoin()
    expect(await screen.findByRole("button", { name: /accept invitation/i })).toBeInTheDocument()
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
    expect(screen.queryByText(/your session expired/i)).not.toBeInTheDocument()
  })
})

// AQU-364: "Magic-link invite is instantly invalid on accept."
//
// Root cause: redeem() collapsed every accept failure into one generic
// "this invite link is no longer valid" message. A JWT that looks valid
// client-side (unexpired `exp` claim) can still be rejected by the server
// (401) — e.g. immediately after signup, before the client's cached session
// is fully in sync — and that 401 is NOT evidence the invite itself is
// dead. Before the fix, isJwtExpired(jwt) returned false for such a token
// (it isn't expired, just rejected), so the code fell through to the
// dead-invite message even though the invite was perfectly valid.
describe("JoinPage AQU-364: accept-time failures are classified honestly", () => {
  it("re-prompts sign-in (not a dead-invite error) when accept returns 401 for a client-side-valid JWT", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false } // not expired client-side
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "unauthorized" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, reason: "unauthorized" })
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    await waitFor(() => expect(acceptServerInvite).toHaveBeenCalled())
    // Must NOT show the dead-invite error — the invite is fine, the session wasn't.
    expect(screen.queryByText("This invite link is no longer valid. Ask the project owner for a fresh link.")).not.toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalledWith(expect.stringMatching(/^\/project\//))
  })

  it("shows the dead-invite error when accept returns a definitive 410 (used)", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "used" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, reason: "used" })
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText("This invite link is no longer valid. Ask the project owner for a fresh link.")).toBeInTheDocument()
  })

  it("shows a network-specific error when accept fails due to a network error", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "network" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, reason: "network" })
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText(/couldn't reach the server/i)).toBeInTheDocument()
  })

  it("shows the wrong-email error when accept returns 403", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "wrong_email" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, reason: "wrong_email" })
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText("This invite was sent to a different email address.")).toBeInTheDocument()
  })
})

describe("JoinPage preview error states (signed-out)", () => {
  it("shows 'no longer valid' error and no signup form when preview returns expired", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({ ok: false, reason: "expired" })
    vi.mocked(previewServerInvite).mockResolvedValueOnce({ ok: false, reason: "expired" })
    renderJoin()
    expect(await screen.findByText("This invite link is no longer valid")).toBeInTheDocument()
    expect(screen.queryByText("do-signup")).not.toBeInTheDocument()
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
    expect(screen.getByText("Back to projects")).toBeInTheDocument()
  })

  it("shows 'no longer valid' error and no signup form when preview returns invalid", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({ ok: false, reason: "invalid" })
    vi.mocked(previewServerInvite).mockResolvedValueOnce({ ok: false, reason: "invalid" })
    renderJoin()
    expect(await screen.findByText("This invite link is no longer valid")).toBeInTheDocument()
    expect(screen.queryByText("do-signup")).not.toBeInTheDocument()
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
  })

  it("shows network error with retry affordance when preview fails with network reason", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({ ok: false, reason: "network" })
    vi.mocked(previewServerInvite).mockResolvedValueOnce({ ok: false, reason: "network" })
    renderJoin()
    expect(await screen.findByText("Couldn't load invitation")).toBeInTheDocument()
    expect(screen.getByText("Try again")).toBeInTheDocument()
    expect(screen.queryByText("do-signup")).not.toBeInTheDocument()
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
  })

  it("valid preview unaffected — shows signup form when preview loads ok", async () => {
    // Default mock already returns {ok:true, data:{projectName:"John",...}}
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument()
    expect(screen.getByText("do-login")).toBeInTheDocument()
    expect(screen.queryByText("This invite link is no longer valid")).not.toBeInTheDocument()
  })

  // AQU-429: distinguish "already used" from "time expired" in the UI
  it("shows 'already been used' message with next-step hint when reason is 'used'", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({ ok: false, reason: "used" })
    vi.mocked(previewServerInvite).mockResolvedValueOnce({ ok: false, reason: "used" })
    renderJoin()
    expect(await screen.findByText("This link has already been used")).toBeInTheDocument()
    // Must explain it's single-use and tell the user to ask for a new one
    expect(screen.getByText(/single-use/i)).toBeInTheDocument()
    expect(screen.getByText(/ask the project owner/i)).toBeInTheDocument()
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
    expect(screen.queryByText("do-signup")).not.toBeInTheDocument()
  })

  it("shows 'expired' message with next-step hint when reason is 'time_expired'", async () => {
    vi.mocked(previewMultiInvite).mockResolvedValueOnce({ ok: false, reason: "time_expired" })
    vi.mocked(previewServerInvite).mockResolvedValueOnce({ ok: false, reason: "time_expired" })
    renderJoin()
    expect(await screen.findByText("This link has expired")).toBeInTheDocument()
    // Must explain expiry and tell the user to ask for a new one
    expect(screen.getByText(/expiry date/i)).toBeInTheDocument()
    expect(screen.getByText(/ask the project owner/i)).toBeInTheDocument()
    expect(screen.queryByText("do-login")).not.toBeInTheDocument()
    expect(screen.queryByText("do-signup")).not.toBeInTheDocument()
  })
})

// AQU-337: the invite summary must read correctly for a single invitee. A
// single-project token arrives through the multi endpoint (one project row),
// and the old copy unconditionally said "You'll join each as …" — wrong for
// one invitee / one project. These tests pin the singular/plural boundary and
// the project-name display so the copy can't silently regress.
describe("InviteSummary (AQU-337 singular/plural copy)", () => {
  it("single project: says 'join as' with no 'each', and names the project", () => {
    render(
      <InviteSummary
        projects={[{ projectId: "p1", projectName: "Genesis Pilot" }]}
        roleName="viewer"
      />,
    )
    expect(screen.getByText(/you'll join as/i)).toBeInTheDocument()
    expect(screen.queryByText(/join each/i)).not.toBeInTheDocument()
    expect(screen.getByText("Genesis Pilot")).toBeInTheDocument()
    expect(screen.getByText("viewer")).toBeInTheDocument()
  })

  it("multiple projects: says 'join each as' and lists every project name", () => {
    render(
      <InviteSummary
        projects={[
          { projectId: "p1", projectName: "Alpha" },
          { projectId: "p2", projectName: "Beta" },
          { projectId: "p3", projectName: "Gamma" },
        ]}
        roleName="contributor"
      />,
    )
    expect(screen.getByText(/you'll join each as/i)).toBeInTheDocument()
    expect(screen.getByText("3 projects")).toBeInTheDocument()
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Gamma")).toBeInTheDocument()
  })

  it("formats an underscored role name into words", () => {
    render(
      <InviteSummary
        projects={[{ projectId: "p1", projectName: "Genesis Pilot" }]}
        roleName="project_lead"
      />,
    )
    expect(screen.getByText("project lead")).toBeInTheDocument()
  })

  it("renders the bound email suffix when present", () => {
    render(
      <InviteSummary
        projects={[{ projectId: "p1", projectName: "Genesis Pilot" }]}
        roleName="viewer"
        email="ryan@example.com"
      />,
    )
    expect(screen.getByText(/invitation sent to/i)).toBeInTheDocument()
    expect(screen.getByText("ryan@example.com")).toBeInTheDocument()
  })

  it("falls back to the project id when the name is empty", () => {
    render(
      <InviteSummary
        projects={[{ projectId: "p-503", projectName: "" }]}
        roleName="viewer"
      />,
    )
    expect(screen.getByText("p-503")).toBeInTheDocument()
  })

  it("marks archived projects in a multi-project list", () => {
    render(
      <InviteSummary
        projects={[
          { projectId: "p1", projectName: "Alpha" },
          { projectId: "p2", projectName: "Beta", archived: true },
        ]}
        roleName="viewer"
      />,
    )
    expect(screen.getByText(/Beta \(archived\)/)).toBeInTheDocument()
  })
})
