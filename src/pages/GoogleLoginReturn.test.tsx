// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { render, waitFor, cleanup, screen, fireEvent } from "@testing-library/react"
import type { GoogleAttempt } from "@/lib/frontier/google-login"
import { MemoryRouter } from "react-router-dom"
const mocks = vi.hoisted(() => ({ request: vi.fn(), finalize: vi.fn(), adopt: vi.fn(), confirm: vi.fn(), readChoice: vi.fn(), clearChoice: vi.fn(), clearAttempt: vi.fn(), attempt: { verifier: "a".repeat(64), next: "/app", expires: 1e20, choice: { allowed: true, version: "2026-11-04", revision: "choice-a" } } as GoogleAttempt, approve: vi.fn() }))
vi.mock("@/lib/frontier/google-return", () => ({ googleReturn: new URLSearchParams({ code: "b".repeat(64) }) }))
vi.mock("@/lib/frontier/google-login", () => ({ googleRequest: mocks.request, readGoogleAttempt: () => mocks.attempt, clearGoogleAttempt: mocks.clearAttempt }))
vi.mock("@/lib/frontier/auth", () => ({ finalizeSession: mocks.finalize }))
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ adopt: mocks.adopt }) }))
vi.mock("@/lib/analytics-account", () => ({ confirmNewAccountAnalytics: mocks.confirm }))
vi.mock("@/lib/signup-analytics-choice", () => ({ readSignupAnalyticsChoice: mocks.readChoice, clearSignupAnalyticsChoice: mocks.clearChoice, confirmSignupAnalyticsChoice: mocks.approve }))
vi.mock("@/lib/i18n/I18nProvider", () => ({ useT: () => (key: string) => key }))
vi.mock("@/components/auth/AuthPage", () => ({ AuthPage: ({ children }: { children: React.ReactNode }) => children, AuthPanel: ({ children }: { children: React.ReactNode }) => children }))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({ FrontierForgotPasswordForm: () => null }))
import { GoogleLoginReturn } from "./GoogleLoginReturn"
beforeEach(() => { vi.clearAllMocks(); mocks.attempt.choice = { allowed: true, version: "2026-11-04", revision: "choice-a" }; mocks.finalize.mockResolvedValue({ jwt: "aquilla-token", username: "alice" }); mocks.adopt.mockResolvedValue(undefined); mocks.confirm.mockResolvedValue(undefined) })
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
