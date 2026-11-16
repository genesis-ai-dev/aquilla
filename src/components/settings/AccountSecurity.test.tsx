// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  adopt: vi.fn(),
  start: vi.fn(),
}))
vi.mock("@/lib/i18n/I18nProvider", () => ({ useT: () => mocks.t }))
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ adopt: mocks.adopt }),
}))
vi.mock("@/lib/frontier/google-login", () => ({
  startGoogleLogin: mocks.start,
}))
vi.mock("@/lib/frontier/auth", () => ({
  AUTH_BASE: "https://auth.example",
  finalizeSession: vi.fn(async (_: string, r: unknown) => r),
}))
import { AccountSecurity, PasswordManagement } from "./AccountSecurity"
let status: Record<string, boolean>
let requests: Array<{ url: string; body: Record<string, unknown> }>
beforeEach(() => {
  status = {
    enabled: true,
    verified: false,
    configured: true,
    password: true,
    google: false,
    google_available: false,
  }
  requests = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const body = options.body ? JSON.parse(String(options.body)) : {}
      requests.push({ url, body })
      if (url.endsWith("/verify")) {
        status.verified = true
        return Response.json({ verified: true })
      }
      if (url.endsWith("/password-proof"))
        return Response.json({ error: "invalid_password" }, { status: 403 })
      return Response.json(status)
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it("locks login settings until the factor is verified, and relocks when focus reveals an expired grant", async () => {
  render(
    <AccountSecurity jwt="token" username="alice">
      <div>private settings</div>
    </AccountSecurity>,
  )
  await screen.findByText(
    "auth.security.verifyWithYourAuthenticatorAppToManageYour",
  )
  expect(screen.queryByText("private settings")).toBeNull()
  fireEvent.click(
    screen.getByRole("button", { name: "auth.security.useARecoveryCode" }),
  )
  fireEvent.change(screen.getByLabelText("auth.security.recoveryCode"), {
    target: { value: "recovery-code" },
  })
  fireEvent.click(screen.getByRole("button", { name: "auth.security.verify" }))
  await screen.findByText("private settings")
  expect(requests.find((r) => r.url.endsWith("/verify"))?.body).toEqual({
    code: "recovery-code",
    recovery: true,
  })
  status = { ...status, verified: false }
  fireEvent(window, new Event("focus"))
  await waitFor(() => expect(screen.queryByText("private settings")).toBeNull())
})
it("offers protection without blocking settings when the factor is not enabled", async () => {
  status.enabled = false
  render(
    <AccountSecurity jwt="token" username="alice">
      <div>private settings</div>
    </AccountSecurity>,
  )
  await screen.findByText("private settings")
  fireEvent.click(
    screen.getByRole("button", { name: "auth.security.enableProtection" }),
  )
  expect(
    screen.getByLabelText("auth.security.currentAquillaPassword"),
  ).toBeVisible()
  expect(
    screen.queryByRole("button", {
      name: "auth.security.verifyWithGoogleInstead",
    }),
  ).toBeNull()
})
it("never offers removal for the last login method and stops a change after a wrong current password", async () => {
  render(
    <PasswordManagement
      jwt="token"
      username="alice"
      google={false}
      googleAvailable={false}
      passwordSet
      onChanged={vi.fn()}
    />,
  )
  expect(
    screen.queryByRole("button", { name: "auth.security.removePassword" }),
  ).toBeNull()
  fireEvent.change(screen.getByLabelText("auth.security.currentPassword"), {
    target: { value: "wrong" },
  })
  fireEvent.change(screen.getByLabelText("auth.security.newAquillaPassword"), {
    target: { value: "new-password" },
  })
  fireEvent.click(
    screen.getByRole("button", { name: "auth.security.changePassword" }),
  )
  await screen.findByText("auth.security.wrongPassword")
  expect(requests.some((r) => r.url.endsWith("/password"))).toBe(false)
})
