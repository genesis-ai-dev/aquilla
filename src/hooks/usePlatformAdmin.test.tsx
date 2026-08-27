import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { usePlatformAdmin } from "./usePlatformAdmin"

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
