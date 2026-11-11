// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { render, waitFor, cleanup, screen, fireEvent } from "@testing-library/react"
import type { GoogleAttempt } from "@/lib/frontier/google-login"
import { MemoryRouter } from "react-router-dom"
const mocks = vi.hoisted(() => ({ active: { username: "alice", jwt: "alice-token" }, request: vi.fn(), finalize: vi.fn(), adopt: vi.fn(), confirm: vi.fn(), readChoice: vi.fn(), clearChoice: vi.fn(), clearAttempt: vi.fn(), attempt: { verifier: "a".repeat(64), next: "/app", expires: 1e20, choice: { allowed: true, version: "2026-11-04", revision: "choice-a" } } as GoogleAttempt, approve: vi.fn() }))
vi.mock("@/lib/frontier/google-return", () => ({ googleReturn: new URLSearchParams({ code: "b".repeat(64) }) }))
vi.mock("@/lib/frontier/google-login", () => ({ googleRequest: mocks.request, readGoogleAttempt: () => mocks.attempt, clearGoogleAttempt: mocks.clearAttempt }))
vi.mock("@/lib/frontier/auth", () => ({ finalizeSession: mocks.finalize }))
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ adopt: mocks.adopt, active: mocks.active, loading: false }) }))
vi.mock("@/lib/analytics-account", () => ({ confirmNewAccountAnalytics: mocks.confirm }))
vi.mock("@/lib/signup-analytics-choice", () => ({ readSignupAnalyticsChoice: mocks.readChoice, clearSignupAnalyticsChoice: mocks.clearChoice, confirmSignupAnalyticsChoice: mocks.approve }))
vi.mock("@/lib/i18n/I18nProvider", () => ({ useT: () => (key: string) => key }))
vi.mock("@/components/auth/AuthPage", () => ({ AuthPage: ({ children }: { children: React.ReactNode }) => children, AuthPanel: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({ FrontierForgotPasswordForm: () => null }))
import { GoogleLoginReturn } from "./GoogleLoginReturn"
beforeEach(() => { vi.clearAllMocks(); delete mocks.attempt.connectUsername; mocks.active = { username: "alice", jwt: "alice-token" }; mocks.attempt.choice = { allowed: true, version: "2026-11-04", revision: "choice-a" }; mocks.finalize.mockResolvedValue({ jwt: "aquilla-token", username: "alice" }); mocks.adopt.mockResolvedValue(undefined); mocks.confirm.mockResolvedValue(undefined) })
afterEach(cleanup)
it.each([
  { created: false, revision: "choice-a", binds: false },
  { created: true, revision: "choice-a", binds: true },
  { created: true, revision: "newer-choice", binds: false },
])("binds consent only to a newly created account and unchanged explicit choice: $created/$revision", async ({ created, revision, binds }) => {
  mocks.readChoice.mockReturnValue({ ...mocks.attempt.choice, revision })
  mocks.request.mockResolvedValue({ access_token: "aquilla-token", token_type: "bearer", username: "alice", created })
  render(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  await waitFor(() => expect(mocks.clearAttempt).toHaveBeenCalledOnce())
  expect(mocks.finalize).toHaveBeenCalledWith("alice", expect.objectContaining({ access_token: "aquilla-token" }))
  expect(mocks.adopt).toHaveBeenCalledWith({ jwt: "aquilla-token", username: "alice" })
  if (binds) {
    expect(mocks.confirm).toHaveBeenCalledWith("aquilla-token", true)
    expect(mocks.adopt.mock.invocationCallOrder[0]).toBeLessThan(mocks.confirm.mock.invocationCallOrder[0])
  } else expect(mocks.confirm).not.toHaveBeenCalled()
})

it.each([true, false])("new Google signup requires an explicit sharing choice before account creation: %s", async allowed => {
  mocks.attempt.choice = null
  mocks.readChoice.mockReturnValue(null)
  mocks.approve.mockImplementation((value: boolean) => mocks.readChoice.mockReturnValue({ allowed: value, version: "2026-11-04", revision: "confirmed" }))
  mocks.request.mockResolvedValueOnce({ continuation: "c".repeat(64), step: "signup", email: "alice@example.com" })
    .mockResolvedValueOnce({ access_token: "aquilla-token", username: "alice", created: true })
  render(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  const toggle = await screen.findByRole("switch")
  expect(toggle).toHaveAttribute("aria-checked", "true")
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.approve).not.toHaveBeenCalled()
  expect(screen.queryByLabelText("auth.signup.usernameLabel")).toBeNull()
  if (!allowed) fireEvent.click(toggle)
  fireEvent.click(screen.getByRole("button", { name: allowed ? "onboarding.privacy.agreeContinue" : "onboarding.privacy.continueWithoutSharing" }))
  expect(mocks.confirm).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText("auth.signup.usernameLabel"), { target: { value: "alice" } })
  fireEvent.submit(screen.getByRole("button", { name: "auth.signup.submitDefault" }).closest("form")!)
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith("aquilla-token", allowed))
  expect(mocks.request).toHaveBeenLastCalledWith("finish", { code: "c".repeat(64), verifier: mocks.attempt.verifier, username: "alice" })
})

it("shows the dev access refusal without adopting a session or sharing analytics", async () => {
  mocks.request.mockRejectedValueOnce(new Error("dev_access_restricted"))
  render(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  expect(await screen.findByRole("alert")).toHaveTextContent("auth.login.devAccessRestricted")
  expect(mocks.adopt).not.toHaveBeenCalled()
  expect(mocks.confirm).not.toHaveBeenCalled()
})

it("connects to the selected account without adopting another session or changing consent", async () => {
  mocks.attempt.connectUsername = "alice"
  mocks.request.mockResolvedValueOnce({ connected: true })
  render(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  expect(mocks.request).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText("auth.google.passwordLabel"), { target: { value: "aquilla-password" } })
  fireEvent.submit(screen.getByRole("button", { name: "auth.methods.connect" }).closest("form")!)
  await waitFor(() => expect(mocks.clearAttempt).toHaveBeenCalledOnce())
  expect(mocks.request).toHaveBeenCalledWith("connect", { code: "b".repeat(64), verifier: mocks.attempt.verifier, password: "aquilla-password" }, "alice-token")
  expect(mocks.finalize).not.toHaveBeenCalled()
  expect(mocks.adopt).not.toHaveBeenCalled()
  expect(mocks.confirm).not.toHaveBeenCalled()
})
it("refuses to finish a connection when another account became selected", () => {
  mocks.attempt.connectUsername = "alice"
  const view = render(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  fireEvent.change(screen.getByLabelText("auth.google.passwordLabel"), { target: { value: "private-password" } })
  mocks.active = { username: "bob", jwt: "bob-token" }
  view.rerender(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  expect(screen.getByRole("alert")).toHaveTextContent("auth.methods.accountChanged")
  expect(mocks.request).not.toHaveBeenCalled()
  expect(screen.queryByRole("button", { name: "auth.methods.connect" })).toBeNull()
  mocks.active = { username: "alice", jwt: "alice-token" }
  view.rerender(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  expect(screen.getByLabelText("auth.google.passwordLabel")).toHaveValue("")
})

it.each(["session_failed","expired_request","unavailable"])("requires a fresh login after terminal completion failure %s", async error => {
  mocks.request.mockResolvedValueOnce({continuation:"c".repeat(64),step:"signup",email:"alice@example.com"})
    .mockRejectedValueOnce(new Error(error))
  render(<MemoryRouter><GoogleLoginReturn /></MemoryRouter>)
  fireEvent.change(await screen.findByLabelText("auth.signup.usernameLabel"),{target:{value:"alice"}})
  fireEvent.submit(screen.getByRole("button",{name:"auth.signup.submitDefault"}).closest("form")!)
  await screen.findByRole("alert")
  expect(screen.queryByRole("button",{name:"auth.signup.submitDefault"})).toBeNull()
  expect(screen.getByRole("link",{name:"auth.google.back"})).toHaveAttribute("href","/login?next=%2Fapp&add=1")
  expect(mocks.adopt).not.toHaveBeenCalled()
  expect(mocks.confirm).not.toHaveBeenCalled()
})
