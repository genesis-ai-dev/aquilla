import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { JoinPage } from "./JoinPage"
import { acceptServerInvite, previewMultiInvite, acceptMultiInvite, previewServerInvite } from "@/lib/sync/invites"

const navigate = vi.fn()
vi.mock("react-router-dom", async (i) => ({
  ...(await i<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

vi.mock("@/lib/sync/invites", () => ({
  acceptServerInvite: vi.fn(async () => ({ projectId: "p1" })),
  previewServerInvite: vi.fn(async () => ({ ok: true, data: { projectName: "John", role: { level: 400, name: "contributor" }, email: null } })),
  previewMultiInvite: vi.fn(async () => ({ ok: false, reason: "invalid" })),
  acceptMultiInvite: vi.fn(async () => null),
}))

let sessionValue: { session: { jwt: string } | null; loading: boolean } = { session: null, loading: false }
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => sessionValue }))

vi.mock("@/components/git-import/FrontierSignupForm", () => ({
  FrontierSignupForm: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>do-signup</button>,
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

  // FRO-335: signed-in users must NOT be auto-joined on link-open — access is
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
    expect(navigate).toHaveBeenCalledWith("/project/p1")
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
      token: "tok",
      accepted: [{ projectId: "pa", role: 400 }, { projectId: "pb", role: 400 }],
    })
    sessionValue = { session: { jwt: "jwt" }, loading: false }
    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))
    await waitFor(() => expect(acceptMultiInvite).toHaveBeenCalledWith("jwt", "tok"))
    expect(navigate).toHaveBeenCalledWith("/project/pa") // first accepted project
  })
})

/** Build a fake JWT whose `exp` claim is `secondsFromNow` seconds out. */
function fakeJwt(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `h.${btoa(JSON.stringify({ exp }))}.s`
}

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

  // FRO-429: distinguish "already used" from "time expired" in the UI
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

describe("JoinPage email-bound mismatch (FRO-443)", () => {
  // A wrong-account redeem used to collapse into "link is no longer valid" —
  // sending the user to ask for a fresh link that would fail identically.
  it("names the bound email instead of claiming the link is dead", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(previewServerInvite).mockResolvedValueOnce({      ok: true,
      data: { projectName: "John", role: { level: 400, name: "contributor" }, email: "bob@example.com" },
    } as Awaited<ReturnType<typeof previewServerInvite>>)
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, code: "email_mismatch" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, code: "email_mismatch" })

    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))

    expect(
      await screen.findByText(/This invite was sent to bob@example\.com/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/no longer valid/)).not.toBeInTheDocument()
  })

  it("falls back to generic mismatch copy when the preview has no email", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, code: "email_mismatch" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, code: "email_mismatch" })

    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))

    expect(
      await screen.findByText(/sent to a different email address/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/no longer valid/)).not.toBeInTheDocument()
  })

  it("still shows the dead-link copy for uncoded failures", async () => {
    sessionValue = { session: { jwt: fakeJwt(3600) }, loading: false }
    vi.mocked(acceptMultiInvite).mockResolvedValueOnce({ ok: false, code: "unknown" })
    vi.mocked(acceptServerInvite).mockResolvedValueOnce({ ok: false, code: "unknown" })

    renderJoin()
    fireEvent.click(await screen.findByRole("button", { name: /accept invitation/i }))

    expect(await screen.findByText(/no longer valid/)).toBeInTheDocument()
  })
})
