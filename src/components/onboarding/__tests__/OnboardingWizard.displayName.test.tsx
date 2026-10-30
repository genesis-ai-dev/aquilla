/**
 * AQU-2259: "What should we call you?" used to be saved to a browser key
 * nothing read. It is the account's display name now (PATCH /auth/me).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { OnboardingWizard } from "../OnboardingWizard"

const updateMyDisplayName = vi.fn(async (_jwt: string, _name: string) => {})
vi.mock("@/lib/frontier/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontier/auth")>()),
  updateMyDisplayName: (jwt: string, name: string) => updateMyDisplayName(jwt, name),
}))
vi.mock("@/lib/frontier/orgs", () => ({ listMyOrgs: vi.fn(async () => []), createPersonalOrg: vi.fn() }))
vi.mock("../steps/WelcomeStep", () => ({
  WelcomeStep: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>Continue from welcome</button>,
}))
vi.mock("../steps/PrivacyStep", () => ({ PrivacyStep: () => <div>Privacy</div> }))
vi.mock("../steps/SignInStep", () => ({
  SignInStep: ({ onSignupComplete }: { onSignupComplete: (s: { username: string; jwt: string; createdAt: string }) => void }) => (
    <button onClick={() => onSignupComplete({ username: "ana", jwt: "jwt-ana", createdAt: "x" })}>Signup complete</button>
  ),
}))
vi.mock("../steps/IntentStep", () => ({ IntentStep: () => <p>Intent step</p> }))
vi.mock("@/lib/analytics-consent", () => ({
  hasAnalyticsConsentBeenSet: () => true,
  isAnalyticsEnabled: () => false,
  onAnalyticsConsentChange: () => () => {},
}))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({ orgs: [], refresh: vi.fn().mockResolvedValue([]), setActiveOrg: vi.fn() }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: null }) }))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

function renderToName() {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes><Route path="/onboarding" element={<OnboardingWizard />} /></Routes>
      </MemoryRouter>
    </I18nProvider>,
  )
  fireEvent.click(screen.getByRole("button", { name: /continue from welcome/i }))
  fireEvent.click(screen.getByRole("button", { name: /signup complete/i }))
}

describe("OnboardingWizard — the name is the account's display name (AQU-2259)", () => {
  it("saves what the person typed", async () => {
    renderToName()
    const input = await screen.findByLabelText(/name/i)
    fireEvent.change(input, { target: { value: "  Ana Kim " } })
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    await waitFor(() => expect(updateMyDisplayName).toHaveBeenCalledWith("jwt-ana", "Ana Kim"))
    expect(await screen.findByText("Intent step")).toBeInTheDocument()
    expect(localStorage.getItem("aquilla:username")).toBeNull()
  })

  it("saves nothing when the field is left empty", async () => {
    renderToName()
    const input = await screen.findByLabelText(/name/i)
    fireEvent.change(input, { target: { value: "  " } })
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(await screen.findByText("Intent step")).toBeInTheDocument()
    expect(updateMyDisplayName).not.toHaveBeenCalled()
  })
})
