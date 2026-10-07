import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { isOnline, useConnectivity } from "./connectivity"

let tauriRuntime = false
vi.mock("./is-tauri", () => ({
  isTauriRuntime: () => tauriRuntime,
}))

const invoke = vi.fn(async (_cmd: string) => true)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}))

let eventHandler: ((event: { payload: { online: boolean } }) => void) | undefined
const unlisten = vi.fn()
const listen = vi.fn(async (_name: string, handler: typeof eventHandler) => {
  eventHandler = handler
  return unlisten
})
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: Parameters<typeof listen>) => listen(...args),
}))

beforeEach(() => {
  tauriRuntime = false
  eventHandler = undefined
  invoke.mockClear()
  listen.mockClear()
  unlisten.mockClear()
})

describe("useConnectivity", () => {
  it("stays null and never invokes outside Tauri", async () => {
    const { result } = renderHook(() => useConnectivity())
    expect(result.current).toBeNull()
    await act(async () => {})
    expect(invoke).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it("fetches the initial value and subscribes to connectivity://changed inside Tauri", async () => {
    tauriRuntime = true
    const { result } = renderHook(() => useConnectivity())
    await waitFor(() => expect(result.current).toBe(true))
    expect(invoke).toHaveBeenCalledWith("get_connectivity")
    expect(listen).toHaveBeenCalledWith("connectivity://changed", expect.any(Function))
  })

  it("updates on a connectivity://changed event", async () => {
    tauriRuntime = true
    const { result } = renderHook(() => useConnectivity())
    await waitFor(() => expect(result.current).toBe(true))

    act(() => {
      eventHandler?.({ payload: { online: false } })
    })
    expect(result.current).toBe(false)
  })

  it("unlistens on unmount", async () => {
    tauriRuntime = true
    const { result, unmount } = renderHook(() => useConnectivity())
    await waitFor(() => expect(result.current).toBe(true))
    unmount()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})

describe("isOnline", () => {
  it("returns null outside Tauri without invoking", async () => {
    expect(await isOnline()).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it("returns the current value inside Tauri", async () => {
    tauriRuntime = true
    invoke.mockResolvedValueOnce(false)
    expect(await isOnline()).toBe(false)
    expect(invoke).toHaveBeenCalledWith("get_connectivity")
  })

  it("returns null if the IPC call rejects", async () => {
    tauriRuntime = true
    invoke.mockRejectedValueOnce(new Error("not ready"))
    expect(await isOnline()).toBeNull()
  })
})
