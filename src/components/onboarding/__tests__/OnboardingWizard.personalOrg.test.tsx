/**
 * AQU-2259: no page read creates an organization any more, so onboarding's
 * "Just me" is the moment the personal workspace is made, and the project
 * the wizard creates next goes into it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { OnboardingWizard } from "../OnboardingWizard"

const createPersonalOrg = vi.fn(async (_jwt: string) => ({ id: 42, name: "ana's workspace", role: { level: 700, name: "owner" } }))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => []),
  createPersonalOrg: (jwt: string) => createPersonalOrg(jwt),
}))
vi.mock("../steps/WelcomeStep", () => ({
  WelcomeStep: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>Continue from welcome</button>,
}))
vi.mock("../steps/PrivacyStep", () => ({ PrivacyStep: () => <div>Privacy</div> }))
vi.mock("../steps/SignInStep", () => ({
  SignInStep: ({ onSignupComplete }: { onSignupComplete: (s: { username: string; jwt: string; createdAt: string }) => void }) => (
    <button onClick={() => onSignupComplete({ username: "ana", jwt: "jwt-ana", createdAt: "x" })}>Signup complete</button>
  ),
}))
vi.mock("../steps/NameStep", () => ({
  NameStep: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>Continue from name</button>,
}))
vi.mock("../steps/IntentStep", () => ({
  IntentStep: ({ onChoosePersonal, onChooseTeam }: { onChoosePersonal: () => void; onChooseTeam: () => void }) => (
    <div><p>Intent step</p><button onClick={onChoosePersonal}>Just me</button><button onClick={onChooseTeam}>My team</button></div>
  ),
}))
vi.mock("../steps/OrgStep", () => ({ OrgStep: () => <div>Org step</div> }))
vi.mock("../steps/ProjectStep", () => ({
  ProjectStep: ({ orgId }: { orgId?: number }) => <p>Project step for org {String(orgId)}</p>,
}))
vi.mock("../steps/ReadyStep", () => ({ ReadyStep: () => <div>Ready</div> }))
vi.mock("@/lib/analytics-consent", () => ({
  hasAnalyticsConsentBeenSet: () => true,
  isAnalyticsEnabled: () => false,
  onAnalyticsConsentChange: () => () => {},
}))
const refresh = vi.fn().mockResolvedValue([])
vi.mock("@/context/OrgContext", () => ({
  useActiveOrg: () => ({ orgs: [], refresh, setActiveOrg: vi.fn() }),
}))
vi.mock("@/hooks/useFrontierSession", () => ({ useFrontierSession: () => ({ session: null }) }))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

async function advanceToIntent() {
  render(
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes><Route path="/onboarding" element={<OnboardingWizard />} /></Routes>
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole("button", { name: /continue from welcome/i }))
  fireEvent.click(screen.getByRole("button", { name: /signup complete/i }))
  fireEvent.click(screen.getByRole("button", { name: /continue from name/i }))
  await waitFor(() => expect(screen.getByText("Intent step")).toBeInTheDocument())
}

describe("OnboardingWizard — the personal workspace is made on \"Just me\" (AQU-2259)", () => {
  it("makes it when Just me is chosen, and creates the project there", async () => {
    await advanceToIntent()
    expect(createPersonalOrg).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Just me" }))
    await waitFor(() => expect(screen.getByText("Project step for org 42")).toBeInTheDocument())
    expect(createPersonalOrg).toHaveBeenCalledWith("jwt-ana")
    expect(refresh).toHaveBeenCalled()
  })

  it("does not make one for My team (that step creates the team)", async () => {
    await advanceToIntent()
    fireEvent.click(screen.getByRole("button", { name: "My team" }))
    await waitFor(() => expect(screen.getByText("Org step")).toBeInTheDocument())
    expect(createPersonalOrg).not.toHaveBeenCalled()
  })
})
