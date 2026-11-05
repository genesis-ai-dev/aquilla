import { confirmSignupAnalyticsChoice } from "@/lib/signup-analytics-choice"
import { confirmNewAccountAnalytics } from "@/lib/analytics-account"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React, { type ReactNode } from "react"

vi.mock("@/lib/analytics-account", async (load) => ({ ...await load<typeof import("@/lib/analytics-account")>(), confirmNewAccountAnalytics: vi.fn(async () => {}) }))
// --- mocks (must be before importing the module under test) ---

vi.mock("@/lib/frontier/auth", () => ({
  AUTH_BASE: "http://localhost/auth",
  login: vi.fn(),
  register: vi.fn(),
}))

vi.mock("@/lib/posthog", () => ({
  default: {
    scope: vi.fn(() => ({ capture: vi.fn() })),
    identify: vi.fn(),
    capture: vi.fn(),
    reset: vi.fn(),
    register: vi.fn(),
  },
}))

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    active: null,
    loading: false,
    adopt: vi.fn(async () => {}),
    removeAll: vi.fn(async () => {}),
  }),
}))

vi.mock("@/lib/frontier/session-store", () => ({
  clearSession: vi.fn(),
  clearAuthHint: vi.fn(),
}))

vi.mock("@/lib/store/project-index", () => ({
  clearAllLocalData: vi.fn(),
}))

vi.mock("@/lib/audio/cache-cleanup", () => ({
  purgeAudioCachesOnSignOut: vi.fn(),
}))

// ---

import { useFrontierSession } from "./useFrontierSession"
import posthog from "@/lib/posthog"
import { login as mockLogin, register as mockRegister } from "@/lib/frontier/auth"


function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

describe("account-scoped login analytics", () => {
  it("keeps login and registration callbacks scoped to their returning account without sending email", async () => {
    const session = { username: "alice", jwt: "tok", createdAt: "x" }
    vi.mocked(mockLogin).mockResolvedValue(session)
    vi.mocked(mockRegister).mockResolvedValue(session)
    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => { await result.current.login("alice", "pw") })
    await act(async () => { await result.current.register("alice", "alice@example.com", "pw") })
    expect(posthog.scope).toHaveBeenNthCalledWith(1, undefined, "alice")
    expect(posthog.scope).toHaveBeenNthCalledWith(2, undefined, "alice")
    expect(posthog.identify).not.toHaveBeenCalled()
  })
  it("invalidates analytics on logout without re-registering an anonymous identity", async () => {
    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => { await result.current.logout() })
    expect(posthog.reset).toHaveBeenCalledOnce()
    expect(posthog.register).not.toHaveBeenCalled()
  })
})

it.each([true, false])("binds confirmed signup choice %s only to the registered account, never a login", async (allowed) => {
  const session = { username: "new", jwt: "new-account-token", createdAt: "now" }
  vi.mocked(mockRegister).mockResolvedValue(session)
  vi.mocked(mockLogin).mockResolvedValue(session)
  const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
  confirmSignupAnalyticsChoice(allowed)
  await act(async () => { await result.current.login("new", "pw") })
  expect(confirmNewAccountAnalytics).not.toHaveBeenCalled()
  confirmSignupAnalyticsChoice(allowed)
  await act(async () => { await result.current.register("new", "new@example.test", "pw") })
  expect(confirmNewAccountAnalytics).toHaveBeenCalledExactlyOnceWith("new-account-token", allowed)
})
