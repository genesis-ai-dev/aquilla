/**
 * AQU-282: OnboardingWizard returning-user skip logic
 *
 * Covers:
 *  - Existing user (has orgs): after login in SignInStep, wizard skips to dashboard
 *  - Fresh user (no orgs, no onboardingComplete): wizard continues to Name step
 *  - localStorage "codex:onboardingComplete" flag also triggers skip
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
  }: {
    onNext: () => void
    onBack: () => void
    onLoginComplete?: () => void
  }) => (
    <div>
      <p>Sign-in step</p>
      <button onClick={() => onLoginComplete?.()}>Login complete</button>
      <button onClick={onNext}>Signup complete</button>
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
let mockOrgs: { id: number; name: string }[] = []

vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({
    orgs: mockOrgs,
    refresh: mockRefreshOrgs,
  }),
}))

const navigate = vi.fn()
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={["/onboarding"]}>
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
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OnboardingWizard — returning user skip", () => {
  it("navigates to / and skips Name step when user has orgs after login", async () => {
    // refreshOrgs resolves with one org (existing user).
    mockRefreshOrgs.mockResolvedValue([{ id: 1, name: "MyOrg" }])

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

  it("navigates to / when localStorage onboardingComplete is set, even with no orgs", async () => {
    localStorage.setItem("codex:onboardingComplete", "true")
    mockRefreshOrgs.mockResolvedValue([]) // no orgs, but flag is set

    renderWizard()
    advanceToSignIn()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /login complete/i }))
    })

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("/")
    })
  })

  it("advances to Name step when fresh user has no orgs and no flag", async () => {
    mockRefreshOrgs.mockResolvedValue([]) // brand-new account

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
