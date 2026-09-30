import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, act } from "@testing-library/react"
import { OfflineSyncManagerMount } from "./OfflineSyncManagerMount"

let activeJwt: string | null = "jwt-1"
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: activeJwt ? { jwt: activeJwt, username: "alice" } : null }),
}))

let mockStore: object | null = null
vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store: mockStore, loading: false, error: null }),
}))

const close = vi.fn()
const createOfflineSyncManager = vi.fn((_options: { store: unknown }) => ({
  close,
  activeProjectIds: () => [],
}))
vi.mock("@/lib/offline/sync-manager", () => ({
  createOfflineSyncManager: (options: { store: unknown }) => createOfflineSyncManager(options),
}))

const buildProjectAwareMinter = vi.fn((_getJwt: () => string | null) => vi.fn())
vi.mock("@/lib/sync/cqrs-bridge", () => ({
  buildProjectAwareMinter: (getJwt: () => string | null) => buildProjectAwareMinter(getJwt),
}))

beforeEach(() => {
  activeJwt = "jwt-1"
  mockStore = null
  close.mockClear()
  createOfflineSyncManager.mockClear()
  buildProjectAwareMinter.mockClear()
})

describe("OfflineSyncManagerMount", () => {
  it("does nothing while no offline store is booted (browser SPA / not-yet-ready Tauri)", () => {
    render(<OfflineSyncManagerMount />)
    expect(createOfflineSyncManager).not.toHaveBeenCalled()
  })

  it("starts the manager once a store is available, and tears it down on unmount", () => {
    mockStore = { id: "fake-store" }
    const { unmount } = render(<OfflineSyncManagerMount />)
    expect(createOfflineSyncManager).toHaveBeenCalledTimes(1)
    expect(createOfflineSyncManager.mock.calls[0][0]).toMatchObject({ store: mockStore })

    unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("mints tokens through a getter that tracks jwt rotation without recreating the manager", () => {
    mockStore = { id: "fake-store" }
    const { rerender } = render(<OfflineSyncManagerMount />)
    expect(buildProjectAwareMinter).toHaveBeenCalledTimes(1)
    const getJwt = buildProjectAwareMinter.mock.calls[0][0] as () => string | null
    expect(getJwt()).toBe("jwt-1")

    // useSessionRefresh rotates the JWT periodically; re-rendering on that
    // rotation must update what getJwt() returns WITHOUT tearing down and
    // recreating the manager (that would drop every open project's socket).
    activeJwt = "jwt-2"
    act(() => {
      rerender(<OfflineSyncManagerMount />)
    })
    expect(getJwt()).toBe("jwt-2")
    expect(createOfflineSyncManager).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })
})
