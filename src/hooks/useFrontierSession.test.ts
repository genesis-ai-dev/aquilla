import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React, { type ReactNode } from "react"

// --- mocks (must be before importing the module under test) ---

vi.mock("@/lib/frontier/auth", () => ({
  login: vi.fn(),
  register: vi.fn(),
}))

vi.mock("@/lib/posthog", () => ({
  default: {
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
import { resolveAppEnv } from "@/lib/analytics-env"

const HEX_RE = /^[0-9a-f]{64}$/

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe("useFrontierSession — distinct id hashing", () => {
  it("login: distinct id is a 64-char hex string, not the raw username", async () => {
    const username = "wendi"
    vi.mocked(mockLogin).mockResolvedValue({ username, jwt: "tok", createdAt: "x" } as never)

    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.login(username, "pw")
    })

    const identifyMock = posthog.identify as ReturnType<typeof vi.fn>
    const [distinctId] = identifyMock.mock.calls[0]
    expect(distinctId).toMatch(HEX_RE)
    expect(distinctId).not.toBe(username)
    expect(distinctId).not.toContain(username)
  })

  it("login: distinct id is deterministic for the same username", async () => {
    const username = "anna"
    vi.mocked(mockLogin).mockResolvedValue({ username, jwt: "tok", createdAt: "x" } as never)

    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => { await result.current.login(username, "pw") })
    await act(async () => { await result.current.login(username, "pw") })

    const identifyMock = posthog.identify as ReturnType<typeof vi.fn>
    const calls = identifyMock.mock.calls
    expect(calls[0][0]).toBe(calls[1][0])
  })

  it("register: distinct id is not the raw username or email", async () => {
    const username = "randall"
    const email = "randall@example.com"
    vi.mocked(mockRegister).mockResolvedValue({ username, jwt: "tok", createdAt: "x" } as never)

    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.register(username, email, "pw")
    })

    const identifyMock = posthog.identify as ReturnType<typeof vi.fn>
    const [distinctId] = identifyMock.mock.calls[0]
    expect(distinctId).toMatch(HEX_RE)
    expect(distinctId).not.toBe(username)
    expect(distinctId).not.toBe(email)
    expect(distinctId).not.toContain(username)
    expect(distinctId).not.toContain(email)
  })

  it("register with analytics opted out: email not passed as person property", async () => {
    // Analytics defaults to ON, so withholding email requires an explicit opt-out
    localStorage.setItem("aquilla:analyticsEnabled", "false")
    const username = "bob"
    const email = "bob@example.com"
    vi.mocked(mockRegister).mockResolvedValue({ username, jwt: "tok", createdAt: "x" } as never)

    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.register(username, email, "pw")
    })

    const identifyMock = posthog.identify as ReturnType<typeof vi.fn>
    // Second arg (personProps) should be empty object (no email)
    expect(identifyMock.mock.calls[0][1]).toEqual({})
  })

  it("register with consent: email passed as person property", async () => {
    localStorage.setItem("aquilla:analyticsEnabled", "true")
    const username = "alice"
    const email = "alice@example.com"
    vi.mocked(mockRegister).mockResolvedValue({ username, jwt: "tok", createdAt: "x" } as never)

    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.register(username, email, "pw")
    })

    const identifyMock = posthog.identify as ReturnType<typeof vi.fn>
    expect(identifyMock.mock.calls[0][1]).toEqual({ email })
  })
})

describe("useFrontierSession — logout keeps the app_env super-property (AQU-1572)", () => {
  it("registers app_env again after posthog.reset() clears it", async () => {
    const { result } = renderHook(() => useFrontierSession(), { wrapper: makeWrapper() })
    await act(async () => {
      await result.current.logout()
    })

    const reset = posthog.reset as ReturnType<typeof vi.fn>
    const register = posthog.register as ReturnType<typeof vi.fn>
    expect(register).toHaveBeenCalledWith({ app_env: resolveAppEnv(window.location) })
    // Order matters: registered before the reset, it would be wiped again.
    expect(register.mock.invocationCallOrder[0]).toBeGreaterThan(reset.mock.invocationCallOrder[0]!)
  })
})
