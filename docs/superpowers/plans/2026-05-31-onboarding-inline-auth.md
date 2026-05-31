# Frictionless Onboarding — Slice 1: inline auth on JoinPage (Phase A)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** A new user who clicks an invite link redeems it **without leaving the page**. Today the signed-out path bounces them to `/` (the dashboard) via a `postLoginRedirect` that nothing reads — so they sign up, then have to find the invite again. Collapse redemption from ~5 steps to ~2.

**Architecture (pure client, zero new primitives):** The repo already has `FrontierLoginForm` + `FrontierSignupForm` (used by `AccountSwitcher`'s `AuthDialogBody`) which authenticate against auth-worker and set the session that `useFrontierSession` reads. Embed them **inline** on the `JoinPage` card. `JoinPage` already has an effect that redeems the moment `session.jwt` appears — so on auth success the invite auto-accepts. Remove the dead `postLoginRedirect` bounce.

**Tech Stack:** React + RTL. No backend, no migration, no new endpoints.

**Out of scope (later slices):** passwordless magic-link claim (needs an auth primitive + security review), persisting/emailing the invite email, wiring the half-built multi-project accept into JoinPage, hashing tokens at rest.

---

### Task OB1: inline auth on JoinPage

**Files:** modify `src/components/JoinPage.tsx`; test `src/components/JoinPage.test.tsx` (create or extend).

- [ ] **Step 1: failing test** — `src/components/JoinPage.test.tsx`. Mock `@/lib/sync/invites` (`previewServerInvite` → a preview; `acceptServerInvite` → `{ projectId: "p1" }`), `@/hooks/useFrontierSession`, and the two Frontier auth form components (render a button that calls `onSuccess`). Render at `/join/tok` via MemoryRouter+Routes.
  - Signed-out: asserts the inline auth affordance renders (e.g. a "Create an account" toggle / the mocked signup form) and there is **no** navigation to `/`.
  - When the session mock flips to having a jwt, assert `acceptServerInvite("jwt", "tok")` is called and navigate goes to `/project/p1`.

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { JoinPage } from "./JoinPage"

const navigate = vi.fn()
vi.mock("react-router-dom", async (i) => ({ ...(await i<typeof import("react-router-dom")>()), useNavigate: () => navigate }))

const acceptServerInvite = vi.fn(async () => ({ projectId: "p1" }))
vi.mock("@/lib/sync/invites", () => ({
  acceptServerInvite: (...a: unknown[]) => acceptServerInvite(...a),
  previewServerInvite: vi.fn(async () => ({ projectName: "John", role: { level: 400, name: "contributor" }, email: null })),
}))
let sessionValue: { session: { jwt: string } | null; loading: boolean } = { session: null, loading: false }
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => sessionValue }))
// Render the real auth forms only as lightweight stand-ins with an onSuccess trigger
vi.mock("@/components/git-import/FrontierSignupForm", () => ({ FrontierSignupForm: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>do-signup</button> }))
vi.mock("@/components/git-import/FrontierLoginForm", () => ({ FrontierLoginForm: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>do-login</button> }))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({ FrontierForgotPasswordForm: () => <div /> }))

function renderJoin() {
  return render(<MemoryRouter initialEntries={["/join/tok"]}><Routes><Route path="/join/:token" element={<JoinPage />} /></Routes></MemoryRouter>)
}
beforeEach(() => { sessionValue = { session: null, loading: false }; vi.clearAllMocks() })

describe("JoinPage inline auth", () => {
  it("shows inline auth (no bounce to /) when signed out", async () => {
    renderJoin()
    expect(await screen.findByText("John")).toBeInTheDocument()
    // a login form is rendered inline; no navigation away
    expect(screen.getByText("do-login")).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalledWith("/")
  })

  it("redeems automatically once a session exists", async () => {
    sessionValue = { session: { jwt: "jwt" }, loading: false }
    renderJoin()
    await waitFor(() => expect(acceptServerInvite).toHaveBeenCalledWith("jwt", "tok"))
    expect(navigate).toHaveBeenCalledWith("/project/p1")
  })
})
```

- [ ] **Step 2: run, verify fail** — `npx vitest run src/components/JoinPage.test.tsx`.

- [ ] **Step 3: implement** — in `src/components/JoinPage.tsx`:
  - Add imports: `FrontierLoginForm`, `FrontierSignupForm`, `FrontierForgotPasswordForm` from `@/components/git-import/...`.
  - Add `const [authMode, setAuthMode] = useState<"login" | "signup" | "forgot">("login")`.
  - Delete `POST_LOGIN_REDIRECT_KEY` + `rememberRedirectAndGoToLogin` (the dead bounce).
  - In the `showPreviewCard` branch, keep the preview block, then **replace the "Sign in or sign up to continue" Button** with the inline auth toggle (mirror `AccountSwitcher`'s `AuthDialogBody`): when `authMode === "login"` render `<FrontierLoginForm onSuccess={() => {}} onForgotPassword={() => setAuthMode("forgot")} />` + a "Create an account" toggle to signup; `"signup"` → `<FrontierSignupForm onSuccess={() => {}} />` + a "Log in" toggle; `"forgot"` → `<FrontierForgotPasswordForm onBack={() => setAuthMode("login")} />`. `onSuccess` can be a no-op — the existing effect (`session?.jwt` → `redeem`) fires on session change. Drop the unused `LogIn` import if it becomes unused.

- [ ] **Step 4: run PASS** + `npx tsc -b` + `npx vitest run src/components/JoinPage.test.tsx`.
- [ ] **Step 5: commit** — `git add src/components/JoinPage.tsx src/components/JoinPage.test.tsx && git commit -m "feat(onboarding): inline sign-in/up on the invite JoinPage (redeem without leaving the page)"`

---

## Self-Review
- Coverage: signed-out invite recipient signs in/up inline and the invite auto-redeems on session change ✓; dead `postLoginRedirect` bounce removed ✓; reuses existing auth forms + endpoints (no new primitive/migration) ✓.
- Risk: `onSuccess` is a no-op by design — redemption is driven by the existing `session.jwt` effect; confirm that effect still runs (it depends on `[token, session?.jwt, sessionLoading]`).
- Follow-up slices (separate): multi-project accept wiring, persist+email invite, passwordless claim, token hashing.
