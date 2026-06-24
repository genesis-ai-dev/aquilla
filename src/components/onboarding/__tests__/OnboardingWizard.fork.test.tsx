/**
 * Bifurcated onboarding: the Personal vs Team fork (IntentStep) routes the
 * wizard differently — Team users get the OrgStep, Personal users skip straight
 * to the ProjectStep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OnboardingWizard } from "../OnboardingWizard"

vi.mock("../steps/WelcomeStep", () => ({
  WelcomeStep: ({ onNext }: { onNext: () => void }) => (
    <button onClick={onNext}>Continue from welcome</button>
  ),
}))
vi.mock("../steps/PrivacyStep", () => ({ PrivacyStep: () => <div>Privacy</div> }))
vi.mock("../steps/SignInStep", () => ({
  SignInStep: ({ onNext }: { onNext: () => void }) => (
    <button onClick={onNext}>Signup complete</button>
  ),
}))
vi.mock("../steps/NameStep", () => ({
  NameStep: ({ onNext }: { onNext: () => void }) => (
    <button onClick={onNext}>Continue from name</button>
  ),
}))
vi.mock("../steps/IntentStep", () => ({
  IntentStep: ({
    onChoosePersonal,
    onChooseTeam,
  }: {
    onChoosePersonal: () => void
    onChooseTeam: () => void
  }) => (
    <div>
      <p>Intent step</p>
      <button onClick={onChoosePersonal}>Just me</button>
      <button onClick={onChooseTeam}>My team</button>
    </div>
  ),
}))
vi.mock("../steps/OrgStep", () => ({ OrgStep: () => <div>Org step</div> }))
vi.mock("../steps/ProjectStep", () => ({ ProjectStep: () => <div>Project step</div> }))
vi.mock("../steps/ReadyStep", () => ({ ReadyStep: () => <div>Ready step</div> }))

vi.mock("@/lib/analytics-consent", () => ({
  hasAnalyticsConsentBeenSet: () => true, // skip privacy
  isAnalyticsEnabled: () => false,
  onAnalyticsConsentChange: () => () => {},
}))
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({ orgs: [], refresh: vi.fn().mockResolvedValue([]), setActiveOrg: vi.fn() }),
}))
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}))

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingWizard />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function advanceToIntent() {
  fireEvent.click(screen.getByRole("button", { name: /continue from welcome/i }))
  fireEvent.click(screen.getByRole("button", { name: /signup complete/i }))
  fireEvent.click(screen.getByRole("button", { name: /continue from name/i }))
  await waitFor(() => expect(screen.getByText("Intent step")).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe("OnboardingWizard — Personal vs Team fork", () => {
  it("routes a Team choice to the OrgStep", async () => {
    renderWizard()
    await advanceToIntent()
    fireEvent.click(screen.getByRole("button", { name: /my team/i }))
    await waitFor(() => expect(screen.getByText("Org step")).toBeInTheDocument())
    expect(screen.queryByText("Project step")).not.toBeInTheDocument()
  })

  it("routes a Personal choice straight to the ProjectStep (skips OrgStep)", async () => {
    renderWizard()
    await advanceToIntent()
    fireEvent.click(screen.getByRole("button", { name: /just me/i }))
    await waitFor(() => expect(screen.getByText("Project step")).toBeInTheDocument())
    expect(screen.queryByText("Org step")).not.toBeInTheDocument()
  })
})
