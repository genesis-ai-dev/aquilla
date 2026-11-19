import { renderWithBrand as render } from "@/test-utils/render-with-brand"
// Every catalog, synchronously: this file asserts translated text (AQU-1991).
import "@/test-utils/all-catalogs"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { screen, waitFor, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { JoinPage, InviteSummary } from "./JoinPage"
import { acceptServerInvite, previewMultiInvite, acceptMultiInvite, previewServerInvite } from "@/lib/sync/invites"
import { resendVerificationEmail } from "@/lib/frontier/auth"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { LanguageSwitcher } from "@/lib/i18n/LanguageSwitcher"
import { CATALOGS } from "@/lib/i18n/messages/all"
import { LOCALE_STORAGE_KEY } from "@/lib/i18n/store"

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

let sessionValue: {
  session: { jwt: string; username?: string; email?: string } | null
  loading: boolean
} = { session: null, loading: false }
// AQU-2576: the email-mismatch rejection offers a sign-out, so the hook's
// logout is part of this page's contract now.
const logoutSpy = vi.fn(async () => {})
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ ...sessionValue, logout: logoutSpy }),
}))

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

// AQU-2639: the verification prompt's one action. isJwtExpired stays real —
// this page's whole session story is built on it.
vi.mock("@/lib/frontier/auth", async (i) => ({
  ...(await i<typeof import("@/lib/frontier/auth")>()),
  resendVerificationEmail: vi.fn(async () => "invitee@example.com"),
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
    // The workspace name is its own node inside the translated sentence now
    // (AQU-511), so it is matched exactly rather than as "in <name>".
    expect(screen.getByText("Come and See")).toBeInTheDocument()
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

  it("shows the wrong-email error when accept returns 403 and the server names no address", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600), username: "Naladda" }, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "wrong_email" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, reason: "wrong_email" })
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText("This invite was sent to a different email address.")).toBeInTheDocument()
  })
})

// AQU-2639: an email-bound invite opened by the very account it was sent to,
// whose address has never been verified (AQU-1579 refuses that), used to show
// one sentence — "Verify your email address before accepting an invite sent to
// it." — and no way to verify anywhere in the app. Nearly every account was in
// that state: 27 of 1,287 on the dev database. The page now carries the action.
describe("JoinPage — unverified email on an email-bound invite (AQU-2639)", () => {
  const session = {
    jwt: fakeJwt(3600),
    username: "Naladda",
    email: "naladda@example.com",
  }

  async function refuse() {
    sessionValue = { session, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "email_unverified" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, reason: "email_unverified" })
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    return screen.findByRole("button", { name: /send verification link/i })
  }

  it("offers a way out instead of naming a requirement with nowhere to satisfy it", async () => {
    await refuse()
    expect(
      screen.getByText(/verify your email address to accept this invite/i),
    ).toBeInTheDocument()
    // Not the wrong-account screen: this IS the right account.
    expect(screen.queryByText(/you're signed in as/i)).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /sign out and use the invited address/i }),
    ).not.toBeInTheDocument()
  })

  it("names the account's own address, masked as every address here is", async () => {
    await refuse()
    expect(screen.getByText("n…a@example.com")).toBeInTheDocument()
    expect(screen.queryByText(/naladda@example\.com/)).not.toBeInTheDocument()
  })

  it("sends the link to the account's own address and confirms where it went", async () => {
    const send = await refuse()
    fireEvent.click(send)
    // The jwt is the only argument — the address is never passed, so this
    // button cannot be pointed at someone else's mailbox.
    await waitFor(() => expect(resendVerificationEmail).toHaveBeenCalledWith(session.jwt))
    expect(await screen.findByText(/verification link sent to i…e@example\.com/i)).toBeInTheDocument()
  })

  it("masks the address the SERVER says it mailed, not the one in client state", async () => {
    vi.mocked(resendVerificationEmail).mockResolvedValueOnce("someone.else@example.com")
    const send = await refuse()
    fireEvent.click(send)
    expect(await screen.findByText(/sent to s…e@example\.com/i)).toBeInTheDocument()
  })

  it("reports the server's refusal rather than claiming a send", async () => {
    vi.mocked(resendVerificationEmail).mockRejectedValueOnce(new Error("rate_limited"))
    const send = await refuse()
    fireEvent.click(send)
    expect(
      await screen.findByText(/too many verification emails were sent/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/verification link sent to/i)).not.toBeInTheDocument()
  })

  it("falls back to a generic failure when the send fails for an unknown reason", async () => {
    vi.mocked(resendVerificationEmail).mockRejectedValueOnce(new Error("unavailable"))
    const send = await refuse()
    fireEvent.click(send)
    expect(
      await screen.findByText(/could not send the verification email\. try again\./i),
    ).toBeInTheDocument()
  })

  it("offers the accept retry only once a link has gone out, and nothing joins before it", async () => {
    const send = await refuse()
    expect(screen.queryByRole("button", { name: /accept invitation/i })).not.toBeInTheDocument()
    fireEvent.click(send)
    const retry = await screen.findByRole("button", { name: /accept invitation/i })

    // Verifying on its own granted nothing: the accept is still an explicit act.
    expect(navigate).not.toHaveBeenCalledWith(expect.stringContaining("/project/"))
    fireEvent.click(retry)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/project/p1/editor"))
  })

  it("leaves the wrong-address rejection alone — a mismatch is not an unverified address", async () => {
    sessionValue = { session, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "wrong_email" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({
      ok: false,
      reason: "wrong_email",
      invitedEmail: "n…l@proton.me",
    })
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    expect(await screen.findByText(/this invite is for/i)).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /send verification link/i }),
    ).not.toBeInTheDocument()
  })
})

// AQU-2576: the real failure this replaces — an invite minted for one address,
// opened by an account registered under another. The old screen said only
// "This invite was sent to a different email address.", which told neither the
// recipient which account to use nor the owner which account to add. It cost a
// Biblica reviewer a working day.
describe("JoinPage — email-mismatch rejection (AQU-2576)", () => {
  const session = {
    jwt: fakeJwt(3600),
    username: "Naladda",
    email: "naladda.other@example.com",
  }

  function mockMismatch(invitedEmail?: string) {
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, reason: "wrong_email" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce(
      invitedEmail
        ? { ok: false, reason: "wrong_email", invitedEmail }
        : { ok: false, reason: "wrong_email" },
    )
  }

  async function reject(invitedEmail?: string) {
    sessionValue = { session, loading: false }
    mockMismatch(invitedEmail)
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
  }

  it("names the address the invite was for, as the server masked it", async () => {
    await reject("n…l@proton.me")
    expect(await screen.findByText(/this invite is for/i)).toBeInTheDocument()
    expect(screen.getByText("n…l@proton.me")).toBeInTheDocument()
  })

  it("names the signed-in account in full — the string the owner needs", async () => {
    await reject("n…l@proton.me")
    expect(await screen.findByText("Naladda")).toBeInTheDocument()
    expect(screen.getByText(/you're signed in as/i)).toBeInTheDocument()
  })

  it("masks the signed-in account's own address", async () => {
    await reject("n…l@proton.me")
    expect(await screen.findByText(/n…r@example\.com/)).toBeInTheDocument()
    expect(screen.queryByText(/naladda\.other@example\.com/)).not.toBeInTheDocument()
  })

  it("offers both ways out: sign in as the invited address, or be added directly", async () => {
    await reject("n…l@proton.me")
    expect(
      await screen.findByRole("button", { name: /sign out and use the invited address/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/ask the project owner to add your account/i)).toBeInTheDocument()
  })

  it("signs out on request, returning the page to its sign-in state", async () => {
    await reject("n…l@proton.me")
    fireEvent.click(
      await screen.findByRole("button", { name: /sign out and use the invited address/i }),
    )
    await waitFor(() => expect(logoutSpy).toHaveBeenCalled())
  })

  it("never auto-joins — the person chose which account to sign in with", async () => {
    await reject("n…l@proton.me")
    await screen.findByText(/this invite is for/i)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("falls back to the generic sentence when the server names no address", async () => {
    await reject()
    expect(
      await screen.findByText("This invite was sent to a different email address."),
    ).toBeInTheDocument()
    // The rest of the help still renders — the username is the fact that
    // unblocks the other way out, and it does not depend on the server.
    expect(screen.getByText(/ask the project owner to add your account/i)).toBeInTheDocument()
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
    expect(screen.getByText(/This invite link is single-use/i)).toBeInTheDocument()
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
    // AQU-832/WS-08: role labels resolve through the catalog now, so the
    // rendered text is "Viewer" (real capitalization, not lowercase text
    // dressed up with CSS `capitalize`).
    expect(screen.getByText("Viewer")).toBeInTheDocument()
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
    // One whole sentence (AQU-511) so a translator controls its word order, AND
    // the count keeps the emphasis the pre-extraction UI gave it. Both, not
    // either: assert the sentence reads correctly and that the numeral is still
    // its own emphasised element.
    const line = screen.getByText(/invited to/).closest("p")
    expect(line?.textContent).toBe("You're invited to 3 projects:")
    const count = screen.getByText("3", { selector: "strong" })
    expect(count).toHaveClass("font-medium")
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Gamma")).toBeInTheDocument()
  })

  it("resolves an underscored canonical role name to its catalog display label", () => {
    render(
      <InviteSummary
        projects={[{ projectId: "p1", projectName: "Genesis Pilot" }]}
        roleName="project_lead"
      />,
    )
    expect(screen.getByText("Project Lead")).toBeInTheDocument()
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

// AQU-511 finding 3, and the grammar bug the extraction hid.
//
// The invite summary used to be assembled from fragment keys ("Project:",
// "Invited by", "You'll join as", "invitation sent to") concatenated in JSX with
// hardcoded English spaces, em dashes and a full stop. Two things were wrong with
// that. A translator could not reorder the sentence — Burmese and Arabic both
// have to — and the deliberate "You'll"/"you'll" case flip that kept the sentence
// grammatical after an "Invited by X — " opening was dropped in extraction, so
// every invite from a known inviter rendered a capital letter mid-sentence.
//
// Each real case is now one whole catalog key with placeholders, so these tests
// assert entire sentences (a fragment assertion is what let the bug through) and
// assert the ELEMENT around each styled placeholder, not just its text — a
// text-only check passes just as happily on a flattened, unstyled sentence.
describe("InviteSummary renders whole translated sentences (AQU-511 finding 3)", () => {
  const single = [{ projectId: "p1", projectName: "Genesis Pilot" }]
  const three = [
    { projectId: "p1", projectName: "Alpha" },
    { projectId: "p2", projectName: "Beta" },
    { projectId: "p3", projectName: "Gamma" },
  ]

  /** The card's last paragraph — the sentence naming the role. */
  const roleLine = (container: HTMLElement) => {
    const paragraphs = container.querySelectorAll("p")
    return paragraphs[paragraphs.length - 1].textContent
  }

  afterEach(() => {
    CATALOGS.my = {}
    window.localStorage.clear()
  })

  it("capitalises the sentence when no inviter is named", () => {
    const { container } = render(<InviteSummary projects={single} roleName="viewer" />)
    expect(roleLine(container)).toBe("You'll join as Viewer.")
  })

  it("continues in lowercase after the 'Invited by' opening", () => {
    // The whole sentence starts with "Invited by Alice — ", so the clause after it
    // is mid-sentence and must not be capitalised. The original JSX flipped the
    // case by hand; extraction replaced it with a hardcoded "You'll", producing
    // "Invited by Alice — You'll join as viewer." for every known inviter.
    const { container } = render(
      <InviteSummary projects={single} roleName="viewer" invitedBy="Alice" />,
    )
    expect(roleLine(container)).toBe("Invited by Alice — you'll join as Viewer.")
  })

  it("keeps the inviter's name emphasised inside the sentence", () => {
    render(<InviteSummary projects={single} roleName="viewer" invitedBy="Alice" />)
    // Who invited you is the salient fact in that clause; flattening it to plain
    // text loses the distinction between the name and the words around it.
    const name = screen.getByText("Alice")
    expect(name.tagName).toBe("SPAN")
    expect(name.className).toContain("font-medium")
  })

  it("keeps the bound email monospaced inside the sentence", () => {
    const { container } = render(
      <InviteSummary projects={single} roleName="viewer" email="ryan@example.com" />,
    )
    // Monospacing marks the address as a literal string to compare character by
    // character against the account you are signed in as.
    expect(screen.getByText("ryan@example.com").className).toContain("font-mono")
    expect(roleLine(container)).toBe(
      "You'll join as Viewer — invitation sent to ryan@example.com.",
    )
  })

  it("keeps the single project's name emphasised inside the sentence", () => {
    render(<InviteSummary projects={single} roleName="viewer" />)
    // The project you are being given access to is the fact the line reports.
    expect(screen.getByText("Genesis Pilot").tagName).toBe("STRONG")
  })

  it("lets a translation reorder the counted project line, count included", () => {
    // The count line is count-governed, so its number is consumed by plural
    // selection and cannot also be a styled node — the fragment version bolded
    // "3 projects" as one English-ordered blob instead. Whole-sentence word order
    // is the thing worth keeping: this translation puts the workspace first and
    // the number last, which the fragments could never have produced.
    CATALOGS.my = {
      "auth.join.summaryMultiInWorkspace": "{workspace} ။ စီမံကိန်း {count} ခု ။",
    }
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "my")
    const { container } = render(
      <I18nProvider>
        <InviteSummary projects={three} roleName="contributor" orgName="Come and See" />
      </I18nProvider>,
    )
    expect(container.querySelector("p")!.textContent).toBe(
      "Come and See ။ စီမံကိန်း 3 ခု ။",
    )
    // The workspace keeps its muted styling even in the reordered sentence.
    expect(screen.getByText("Come and See").className).toContain("text-muted-foreground")
  })

  it("names the workspace as a distinct muted node inside the sentence", () => {
    const { container } = render(
      <InviteSummary projects={single} roleName="viewer" orgName="Come and See" />,
    )
    // The workspace is secondary context, which is what the muted colour says.
    const org = screen.getByText("Come and See")
    expect(org.className).toContain("text-muted-foreground")
    expect(container.querySelector("p")!.textContent).toBe(
      "Project: Genesis Pilot in Come and See",
    )
  })

  it("renders in the translation's word order, not the call site's", () => {
    // The reason whole-sentence keys exist at all: a translation must be able to
    // put the role before the inviter, and to use its own punctuation. While the
    // sentence was concatenated fragments, the order was frozen in the JSX and no
    // translation could move it.
    CATALOGS.my = {
      "auth.join.roleLineSingleInviter": "{role} · invited by {inviter} ။",
    }
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "my")
    const { container } = render(
      <I18nProvider>
        <InviteSummary projects={single} roleName="viewer" invitedBy="Alice" />
      </I18nProvider>,
    )
    // Burmese ("my") has no CLDR "one" category — Intl.PluralRules("my").select(1)
    // already returns "other" (see plurals.ts) — and this test's CATALOGS.my
    // doesn't translate common.role.viewer, so the fallback chain lands on
    // English's "other" form ("Viewers") rather than "one" ("Viewer"). That's
    // the documented fallback chain working as designed, not a role-catalog bug.
    expect(roleLine(container)).toBe("Viewers · invited by Alice ။")
  })
})

// AQU-511 finding 7. Three of JoinPage's error messages were resolved with t()
// at the moment the failure happened and stored as plain strings, one of them in
// an effect whose dependency array omitted `t` behind an eslint-disable. Whatever
// language was active then was frozen into the message, so switching language
// left a stale-language error on screen. The state now holds the message KEY and
// resolves it at render.
describe("JoinPage error messages follow a language switch (AQU-511 finding 7)", () => {
  afterEach(() => {
    CATALOGS.my = {}
    window.localStorage.clear()
  })

  it("re-resolves the invalid-link error into the newly chosen language", async () => {
    CATALOGS.my = { "auth.join.invalidInviteLink": "MY invalid invite link" }
    render(
      <I18nProvider>
        <LanguageSwitcher />
        <MemoryRouter initialEntries={["/join"]}>
          <Routes>
            <Route path="/join" element={<JoinPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    )
    expect(screen.getByText("Invalid invite link")).toBeInTheDocument()

    // Open the globe menu and pick Burmese by its endonym.
    await userEvent.click(screen.getByRole("button", { name: "Language" }))
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /မြန်မာ/ }))

    expect(screen.getByText("MY invalid invite link")).toBeInTheDocument()
    expect(screen.queryByText("Invalid invite link")).not.toBeInTheDocument()
  })
})
