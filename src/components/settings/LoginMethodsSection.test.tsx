// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ active: { username: "alice", jwt: "alice-token" } as { username: string; jwt: string } | null, request: vi.fn(), start: vi.fn() }))
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
