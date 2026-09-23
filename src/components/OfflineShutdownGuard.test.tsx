import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, act } from "@testing-library/react"
import { OfflineShutdownGuard } from "./OfflineShutdownGuard"

let tauriRuntime = false
vi.mock("@/lib/offline/is-tauri", () => ({
  isTauriRuntime: () => tauriRuntime,
}))

let mockStore: unknown = null
vi.mock("@/context/OfflineStoreContext", () => ({
  useOfflineStore: () => ({ store: mockStore, loading: false, error: null }),
}))

const shutdownGracefully = vi.fn(async (_store: unknown, _timeoutMs?: number) => {})
vi.mock("@/lib/offline/shutdown", () => ({
  shutdownOfflineStoreGracefully: (store: unknown, timeoutMs?: number) => shutdownGracefully(store, timeoutMs),
}))

const invoke = vi.fn(async (_cmd: string) => undefined)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}))

let eventHandler: (() => void) | undefined
const unlisten = vi.fn()
const listen = vi.fn(async (_name: string, handler: () => void) => {
  eventHandler = handler
  return unlisten
})
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof listen>) => listen(...args),
}))

beforeEach(() => {
  tauriRuntime = false
  mockStore = null
  eventHandler = undefined
  shutdownGracefully.mockClear()
  invoke.mockClear()
  listen.mockClear()
  unlisten.mockClear()
})

describe("OfflineShutdownGuard", () => {
  it("does not register a listener outside Tauri", async () => {
    render(<OfflineShutdownGuard />)
    await act(async () => {})
    expect(listen).not.toHaveBeenCalled()
  })

  it("registers the prepare-shutdown listener inside Tauri", async () => {
    tauriRuntime = true
    render(<OfflineShutdownGuard />)
    await act(async () => {})
    expect(listen).toHaveBeenCalledWith("offline://prepare-shutdown", expect.any(Function))
  })

  it("flushes the booted store then confirms shutdown on prepare-shutdown", async () => {
    tauriRuntime = true
    mockStore = { id: "fake-store" }
    render(<OfflineShutdownGuard />)
    await act(async () => {})

    await act(async () => {
      eventHandler?.()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(shutdownGracefully).toHaveBeenCalledWith(mockStore, undefined)
    expect(invoke).toHaveBeenCalledWith("confirm_offline_shutdown")
  })

  it("confirms immediately without flushing when no store ever booted", async () => {
    tauriRuntime = true
    mockStore = null
    render(<OfflineShutdownGuard />)
    await act(async () => {})

    await act(async () => {
      eventHandler?.()
      await Promise.resolve()
    })

    expect(shutdownGracefully).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith("confirm_offline_shutdown")
  })

  it("still confirms shutdown even if flushing throws", async () => {
    tauriRuntime = true
    mockStore = { id: "fake-store" }
    shutdownGracefully.mockRejectedValueOnce(new Error("leader unreachable"))
    render(<OfflineShutdownGuard />)
    await act(async () => {})

    await act(async () => {
      eventHandler?.()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith("confirm_offline_shutdown")
  })

  it("unlistens on unmount", async () => {
    tauriRuntime = true
    const { unmount } = render(<OfflineShutdownGuard />)
    await act(async () => {})
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
