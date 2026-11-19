import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePlatformAdmin } from "./usePlatformAdmin"
import { resetPlatformAdminProbe } from "@/lib/frontier/platform-admin-probe"

const authState = vi.hoisted(() => ({
  session: { jwt: "old-jwt", username: "alice", createdAt: "old" },
}))
const getAdminMe = vi.hoisted(() => vi.fn())

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: authState.session, loading: false }),
}))
vi.mock("@/lib/frontier/admin", () => ({ getAdminMe }))
vi.mock("@/lib/frontier/session-expiry", () => ({
  notifySessionExpiredIfCurrent: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("usePlatformAdmin request fencing", () => {
  beforeEach(() => {
    authState.session = { jwt: "old-jwt", username: "alice", createdAt: "old" }
    getAdminMe.mockReset()
    resetPlatformAdminProbe()
  })

  it("does not restore stale admin capability after a same-account JWT refresh", async () => {
    const oldRequest = deferred<boolean>()
    const newRequest = deferred<boolean>()
    getAdminMe.mockImplementation((jwt: string) =>
      jwt === "old-jwt" ? oldRequest.promise : newRequest.promise,
    )
    const hook = renderHook(() => usePlatformAdmin())
    await waitFor(() => expect(getAdminMe).toHaveBeenCalledTimes(1))

    authState.session = { jwt: "new-jwt", username: "alice", createdAt: "new" }
    hook.rerender()
    await waitFor(() => expect(getAdminMe).toHaveBeenCalledTimes(2))

    await act(async () => { newRequest.resolve(false) })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    expect(hook.result.current.isAdmin).toBe(false)

    await act(async () => { oldRequest.resolve(true) })
    expect(hook.result.current.isAdmin).toBe(false)
  })
})

describe("usePlatformAdmin shared probe (AQU-2654)", () => {
  beforeEach(() => {
    authState.session = { jwt: "old-jwt", username: "alice", createdAt: "old" }
    getAdminMe.mockReset()
    resetPlatformAdminProbe()
  })

  it("sends one request for three consumers mounted together", async () => {
    const request = deferred<boolean>()
    getAdminMe.mockReturnValue(request.promise)
    const sidebar = renderHook(() => usePlatformAdmin())
    const switcher = renderHook(() => usePlatformAdmin())
    const gate = renderHook(() => usePlatformAdmin())
    await waitFor(() => expect(getAdminMe).toHaveBeenCalledTimes(1))

    await act(async () => { request.resolve(true) })
    for (const hook of [sidebar, switcher, gate]) {
      await waitFor(() => expect(hook.result.current).toEqual({ isAdmin: true, loading: false }))
    }
    expect(getAdminMe).toHaveBeenCalledTimes(1)
  })

  it("a consumer mounted after the answer starts settled and sends nothing", async () => {
    getAdminMe.mockResolvedValue(true)
    const first = renderHook(() => usePlatformAdmin())
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    first.unmount()

    const renders: Array<{ isAdmin: boolean; loading: boolean }> = []
    renderHook(() => {
      const state = usePlatformAdmin()
      renders.push(state)
      return state
    })
    // The next page's sidebar: never a loading frame, never a second request.
    expect(renders[0]).toEqual({ isAdmin: true, loading: false })
    await act(async () => {})
    expect(renders.every((state) => state.isAdmin && !state.loading)).toBe(true)
    expect(getAdminMe).toHaveBeenCalledTimes(1)
  })

  it("does not keep a failed probe", async () => {
    getAdminMe.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(true)
    const first = renderHook(() => usePlatformAdmin())
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(first.result.current.isAdmin).toBe(false)
    first.unmount()

    const second = renderHook(() => usePlatformAdmin())
    await waitFor(() => expect(second.result.current).toEqual({ isAdmin: true, loading: false }))
    expect(getAdminMe).toHaveBeenCalledTimes(2)
  })
})
