// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ active: { username: "alice", jwt: "alice-token" } as { username: string; jwt: string } | null, request: vi.fn(), start: vi.fn(), rejected: vi.fn() }))
vi.mock("@/lib/frontier/session-expiry", () => ({ notifySessionExpiredIfCurrent: mocks.rejected }))
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ active: mocks.active }) }))
vi.mock("@/lib/i18n/I18nProvider", () => ({ useT: () => (key: string) => key }))
vi.mock("@/lib/frontier/google-login", () => ({ googleRequest: mocks.request, startGoogleLogin: mocks.start }))
vi.mock("@/components/git-import/FrontierForgotPasswordForm", () => ({ FrontierForgotPasswordForm: () => <div>email-reset</div> }))
import { MemoryRouter } from "react-router-dom"
import { LoginMethodsSection } from "./LoginMethodsSection"
beforeEach(() => { vi.clearAllMocks(); mocks.active = { username: "alice", jwt: "alice-token" }; mocks.start.mockResolvedValue(undefined) })
afterEach(cleanup)
it("does not start Google before the connect click and binds that attempt to the selected account", async () => {
  mocks.request.mockResolvedValue({ password: true, google: false, google_available: true })
  render(<LoginMethodsSection />)
  const connect = await screen.findByRole("button", { name: "auth.methods.connect" })
  expect(mocks.request).toHaveBeenCalledWith("methods", undefined, "alice-token")
  expect(mocks.start).not.toHaveBeenCalled()
  fireEvent.click(connect)
  expect(mocks.start).toHaveBeenCalledWith("/preferences/login-methods", false, "alice")
})
it("keeps a Google-only account connected and offers the existing email reset flow", async () => {
  mocks.request.mockResolvedValue({ password: false, google: true, google_available: true })
  render(<LoginMethodsSection />)
  fireEvent.click(await screen.findByRole("button", { name: "auth.methods.setPassword" }))
  expect(screen.queryByRole("button", { name: "auth.methods.disconnect" })).toBeNull()
  expect(screen.getByText("email-reset")).toBeVisible()
})
it("clears account-specific status and password when switching accounts", async () => {
  mocks.request.mockResolvedValueOnce({ password: true, google: true, google_available: true })
    .mockResolvedValueOnce({ password: false, google: true, google_available: true })
  const view = render(<LoginMethodsSection />)
  fireEvent.click(await screen.findByRole("button", { name: "auth.methods.disconnect" }))
  fireEvent.change(screen.getByLabelText("auth.google.passwordLabel"), { target: { value: "alice-secret" } })
  mocks.active = { username: "bob", jwt: "bob-token" }; view.rerender(<LoginMethodsSection />)
  await waitFor(() => expect(mocks.request).toHaveBeenLastCalledWith("methods", undefined, "bob-token"))
  expect(screen.queryByLabelText("auth.google.passwordLabel")).toBeNull()
  expect(screen.queryByDisplayValue("alice-secret")).toBeNull()
})

it("offers email password reset even when a password is already set", async () => {
  mocks.request.mockResolvedValue({ password: true, google: true, google_available: true })
  render(<LoginMethodsSection />)
  fireEvent.click(await screen.findByRole("button", { name: "auth.methods.resetPassword" }))
  expect(screen.getByText("email-reset")).toBeVisible()
  expect(mocks.start).not.toHaveBeenCalled()
})

it("does not duplicate the sidebar login action or request account data while logged out", () => {
  mocks.active = null
  render(<MemoryRouter><LoginMethodsSection /></MemoryRouter>)
  expect(screen.queryByRole("link")).toBeNull()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})

it("opens password setup directly from the email-change prerequisite", async () => {
  mocks.request.mockResolvedValue({ email: "alice@example.com", password: false, google: true, google_available: true })
  render(<MemoryRouter><LoginMethodsSection /></MemoryRouter>)
  fireEvent.click(await screen.findByRole("button", { name: "auth.emailChange.action" }))
  expect(screen.queryByRole("button", { name: "auth.emailChange.back" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "auth.methods.setPassword" }))
  expect(screen.getByText("email-reset")).toBeVisible()
  expect(screen.queryByText("auth.emailChange.password_required")).toBeNull()
  expect(mocks.start).not.toHaveBeenCalled()
})

it("uses shared recovery for a rejected credential without a duplicate login link", async () => {
  mocks.request.mockRejectedValueOnce(new Error("session_expired"))
  render(<LoginMethodsSection />)
  await waitFor(() => expect(mocks.rejected).toHaveBeenCalledWith("alice-token"))
  expect(screen.queryByRole("link")).toBeNull()
  expect(screen.queryByRole("alert")).toBeNull()
})
it.each(["unavailable", "dev_access_restricted", "Forbidden"])("does not mark login expired for %s", async reason => {
  mocks.request.mockRejectedValueOnce(new Error(reason))
  render(<LoginMethodsSection />)
  expect(await screen.findByRole("button", { name: "auth.methods.refresh" })).toBeVisible()
  expect(mocks.rejected).not.toHaveBeenCalled()
})
it("ignores a late methods rejection after the account token is replaced", async () => {
  let reject!: (error: Error) => void
  mocks.request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    .mockResolvedValueOnce({ password: true, google: false, google_available: true })
  const view = render(<LoginMethodsSection />)
  mocks.active = { username: "alice", jwt: "renewed-token" }
  view.rerender(<LoginMethodsSection />)
  await screen.findByRole("button", { name: "auth.methods.connect" })
  reject(new Error("session_expired"))
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
  expect(mocks.rejected).not.toHaveBeenCalled()
})

it("refreshes password status when the user returns from another tab", async () => {
  mocks.request.mockResolvedValueOnce({ email: "alice@example.com", password: false, google: true, google_available: true })
    .mockResolvedValueOnce({ email: "alice@example.com", password: true, google: true, google_available: true })
  render(<MemoryRouter><LoginMethodsSection /></MemoryRouter>)
  expect(await screen.findByText("auth.methods.passwordMissing")).toBeVisible()
  fireEvent.focus(window)
  expect(await screen.findByText("auth.methods.passwordSet")).toBeVisible()
  expect(mocks.request).toHaveBeenCalledTimes(2)
})
it("keeps email edits while refreshing login methods", async () => {
  const methods = { email: "alice@example.com", password: true, google: false, google_available: true }
  mocks.request.mockResolvedValue(methods)
  render(<MemoryRouter><LoginMethodsSection /></MemoryRouter>)
  fireEvent.click(await screen.findByRole("button", { name: "auth.emailChange.action" }))
  fireEvent.change(screen.getByLabelText("auth.emailChange.address"), { target: { value: "new@example.com" } })
  fireEvent.focus(window)
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByRole("button", { name: "auth.emailChange.action" })).toBeEnabled())
  expect(screen.getByLabelText("auth.emailChange.address")).toHaveValue("new@example.com")
})
it("keeps a retry available and does not trust stale password status after a refresh fails", async () => {
  mocks.request.mockResolvedValueOnce({ email: "alice@example.com", password: false, google: true, google_available: true })
    .mockRejectedValueOnce(new Error("unavailable"))
  render(<MemoryRouter><LoginMethodsSection /></MemoryRouter>)
  fireEvent.click(await screen.findByRole("button", { name: "auth.emailChange.action" }))
  fireEvent.focus(window)
  expect(await screen.findByRole("alert")).toBeVisible()
  expect(screen.getByRole("button", { name: "auth.methods.setPassword" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "auth.methods.refresh" })).toBeEnabled()
})

it("closes the setup message when a password is set in another tab", async () => {
  mocks.request.mockResolvedValueOnce({ email: "alice@example.com", password: false, google: true, google_available: true })
    .mockResolvedValueOnce({ email: "alice@example.com", password: true, google: true, google_available: true })
  render(<MemoryRouter><LoginMethodsSection /></MemoryRouter>)
  fireEvent.click(await screen.findByRole("button", { name: "auth.methods.setPassword" }))
  expect(screen.getByText("email-reset")).toBeVisible()
  fireEvent.focus(window)
  expect(await screen.findByText("auth.methods.passwordSet")).toBeVisible()
  expect(screen.queryByText("email-reset")).toBeNull()
})
it("keeps an intentionally opened password reset panel when the password was already set", async () => {
  mocks.request.mockResolvedValue({ email: "alice@example.com", password: true, google: true, google_available: true })
  render(<MemoryRouter><LoginMethodsSection /></MemoryRouter>)
  fireEvent.click(await screen.findByRole("button", { name: "auth.methods.resetPassword" }))
  fireEvent.focus(window)
  await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2))
  expect(screen.getByText("email-reset")).toBeVisible()
})
