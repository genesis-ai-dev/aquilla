import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook } from "@testing-library/react"

// src/test-setup.ts replaces this hook for ordinary product tests; this file
// is about the hook itself.
vi.unmock("@/hooks/useAccountAnalytics")

const account = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const self = {
    state: { generation: 0, username: null as string | null },
    eligible: false,
    publish(update: Partial<{ generation: number; username: string | null }>, eligible = self.eligible) {
      self.state = { ...self.state, ...update }
      self.eligible = eligible
      for (const listener of listeners) listener()
    },
    listeners,
  }
  return self
})

vi.mock("@/lib/analytics-account", () => ({
  analyticsAccount: {
    getSnapshot: () => account.state,
    subscribe: (listener: () => void) => {
      account.listeners.add(listener)
      return () => { account.listeners.delete(listener) }
    },
    eligible: () => account.eligible,
  },
}))

// The real scope decides approval when it is made (src/lib/posthog.ts).
vi.mock("@/lib/posthog", () => ({
  default: {
    scope: (generation: number) => {
      const approvedWhenMade = account.eligible
      return {
        owner: account.state.username,
        enabled: () => approvedWhenMade && generation === account.state.generation && account.eligible,
        capture: vi.fn(),
        captureException: vi.fn(),
      }
    },
  },
}))

import { useAccountAnalytics } from "./useAccountAnalytics"

beforeEach(() => {
  account.listeners.clear()
})

describe("useAccountAnalytics (AQU-2654)", () => {
  it("keeps one scope, and renders nothing, while the account is republished without approval", () => {
    act(() => account.publish({ generation: 100, username: "ryder" }, false))
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useAccountAnalytics()
    })
    const scope = result.current
    const rendersBefore = renders
    // Hide the tab, come back: suspended, invalidated, suspended again.
    act(() => account.publish({ generation: 101 }, false))
    act(() => account.publish({ generation: 102 }, false))
    act(() => account.publish({ generation: 103 }, false))
    expect(result.current).toBe(scope)
    expect(renders).toBe(rendersBefore)
    expect(scope.enabled()).toBe(false)
  })

  it("hands out a new scope when collection becomes approved, and the old one still cannot send", () => {
    act(() => account.publish({ generation: 200, username: "ryder" }, false))
    const { result } = renderHook(() => useAccountAnalytics())
    const unapproved = result.current
    act(() => account.publish({ generation: 200 }, true))
    expect(result.current).not.toBe(unapproved)
    expect(result.current.enabled()).toBe(true)
    expect(unapproved.enabled()).toBe(false)
  })

  it("a scope from an earlier generation does not outlive it", () => {
    act(() => account.publish({ generation: 300, username: "ryder" }, true))
    const { result } = renderHook(() => useAccountAnalytics())
    const first = result.current
    expect(first.enabled()).toBe(true)
    act(() => account.publish({ generation: 301 }, true))
    expect(result.current).not.toBe(first)
    expect(first.enabled()).toBe(false)
    expect(result.current.enabled()).toBe(true)
  })

  it("keeps unapproved scopes apart per owner", () => {
    act(() => account.publish({ generation: 400, username: "ryder" }, false))
    const { result } = renderHook(() => useAccountAnalytics())
    expect(result.current.owner).toBe("ryder")
    act(() => account.publish({ generation: 401, username: null }, false))
    expect(result.current.owner).toBeNull()
    act(() => account.publish({ generation: 402, username: "alex" }, false))
    expect(result.current.owner).toBe("alex")
  })
})
