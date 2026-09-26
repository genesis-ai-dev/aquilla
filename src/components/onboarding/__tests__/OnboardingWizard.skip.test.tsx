/**
 * AQU-282: OnboardingWizard returning-user skip logic
 *
 * Covers:
 *  - Existing user (has orgs): after login in SignInStep, wizard skips to dashboard
 *  - Fresh user (no orgs, no onboardingComplete): wizard continues to Name step
 *  - per-account completion never leaks through the browser-local marker
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OnboardingWizard } from "../OnboardingWizard"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Mock child steps minimally — we care about wizard-level skip logic, not step internals.

vi.mock("../steps/WelcomeStep", () => ({
  WelcomeStep: ({ onNext }: { onNext: () => void }) => (
    <div>
      <p>Welcome</p>
      <button onClick={onNext}>Continue from welcome</button>
    </div>
  ),
}))

vi.mock("../steps/PrivacyStep", () => ({
  PrivacyStep: ({ onNext }: { onNext: () => void }) => (
    <div>
      <p>Privacy</p>
      <button onClick={onNext}>Accept privacy</button>
    </div>
  ),
}))

vi.mock("../steps/SignInStep", () => ({
  SignInStep: ({
    onNext,
    onLoginComplete,
    onSignupComplete,
    continuationError,
    continuationBusy,
  }: {
    onNext: () => void
    onBack: () => void
    onLoginComplete?: (session: { username: string; jwt: string; createdAt: string }) => void
    onSignupComplete?: (session: { username: string; jwt: string; createdAt: string }) => void
    continuationError?: string | null
    continuationBusy?: boolean
  }) => (
    <div>
      <p>Sign-in step</p>
      {continuationError && <p role="alert">{continuationError}</p>}
      <button disabled={continuationBusy} onClick={() => onLoginComplete?.({ username: "alice", jwt: "jwt-alice", createdAt: "x" })}>Login complete</button>
      <button onClick={() => {
        if (onSignupComplete) onSignupComplete({ username: "alice", jwt: "jwt-alice", createdAt: "x" })
        else onNext()
      }}>Signup complete</button>
    </div>
  ),
}))

vi.mock("../steps/NameStep", () => ({
  NameStep: () => <div><p>Name step</p></div>,
}))

vi.mock("../steps/ProjectStep", () => ({
  ProjectStep: () => <div><p>Project step</p></div>,
}))

vi.mock("../steps/ReadyStep", () => ({
  ReadyStep: () => <div><p>Ready step</p></div>,
}))

vi.mock("@/lib/analytics-consent", () => ({
  hasAnalyticsConsentBeenSet: () => true, // skip privacy step to simplify
  // posthog.ts calls these at import time
  isAnalyticsEnabled: () => false,
  onAnalyticsConsentChange: () => () => {},
}))

const mockRefreshOrgs = vi.fn()
const mockListMyOrgs = vi.fn()
let mockOrgs: { id: number; name: string }[] = []
let mockUsername: string | null = "alice"

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    orgs: mockOrgs,
    refresh: mockRefreshOrgs,
  }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: mockUsername ? { username: mockUsername, jwt: "jwt", createdAt: "x" } : null,
  }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: (...args: unknown[]) => mockListMyOrgs(...args),
}))

const navigate = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWizard(path = "/onboarding") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}

function advanceToSignIn() {
  // Privacy is skipped (hasAnalyticsConsentBeenSet returns true).
  // Step 1 = Welcome → click Continue
  fireEvent.click(screen.getByRole("button", { name: /continue from welcome/i }))
  // Now at step 3 (SignInStep) — privacy was skipped.
}

beforeEach(() => {
  vi.clearAllMocks()
  navigate.mockReset()
  mockOrgs = []
  mockUsername = "alice"
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OnboardingWizard — returning user skip", () => {
  it("stays at the decision step and retries when organization classification fails", async () => {
    mockListMyOrgs.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([])
    renderWizard()
    advanceToSignIn()

    fireEvent.click(screen.getByRole("button", { name: /login complete/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't check/i)
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.queryByText("Name step")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: /login complete/i }))
    expect(await screen.findByText("Name step")).toBeInTheDocument()
  })

  it("navigates to / and skips Name step when user has orgs after login", async () => {
    mockListMyOrgs.mockResolvedValue([{ id: 1, name: "MyOrg" }])

    renderWizard()
    advanceToSignIn()

    expect(screen.getByText("Sign-in step")).toBeInTheDocument()

    // Simulate login completion.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /login complete/i }))
    })

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("/")
    })

    // Must NOT show the Name step.
    expect(screen.queryByText("Name step")).not.toBeInTheDocument()
  })

  it("navigates to / when this account's onboarding marker is set, even with no orgs", async () => {
    localStorage.setItem("aquilla:onboardingComplete:account:alice", "true")
    mockListMyOrgs.mockResolvedValue([]) // no orgs, but flag is set

    renderWizard()
    advanceToSignIn()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /login complete/i }))
    })

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("/")
    })
  })

  it("does not let another browser account's completion skip onboarding", async () => {
    localStorage.setItem("aquilla:onboardingComplete", "true")
    localStorage.setItem("aquilla:onboardingComplete:account:bob", "true")
    mockUsername = null // React has not committed the just-authenticated account yet.
    mockListMyOrgs.mockResolvedValue([])

    renderWizard()
    advanceToSignIn()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /login complete/i }))
    })

    expect(await screen.findByText("Name step")).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("advances to Name step when fresh user has no orgs and no flag", async () => {
    mockListMyOrgs.mockResolvedValue([]) // brand-new account

    renderWizard()
    advanceToSignIn()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /login complete/i }))
    })

    await waitFor(() => {
      expect(screen.getByText("Name step")).toBeInTheDocument()
    })
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("OnboardingWizard — fresh-signup path unchanged", () => {
  it("advances to Name step when signup (not login) completes", async () => {
    renderWizard()
    advanceToSignIn()

    // "Signup complete" fires onNext (not onLoginComplete).
    fireEvent.click(screen.getByRole("button", { name: /signup complete/i }))

    await waitFor(() => {
      expect(screen.getByText("Name step")).toBeInTheDocument()
    })
    expect(mockRefreshOrgs).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})

it("preserves a paid marketing selection when a returning account signs in", async () => {
  mockListMyOrgs.mockResolvedValue([{ id: 7, name: "Existing" }])
  renderWizard("/onboarding?offer=max-20x&interval=annual&quantity=1&audience=individual")
  advanceToSignIn()
  fireEvent.click(screen.getByRole("button", { name: "Login complete" }))
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/billing/select?offer=max_20x&interval=year&quantity=1"))
})
