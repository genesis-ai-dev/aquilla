import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getUnavailableProjects,
  isProjectUnavailable,
  markProjectUnavailable,
  resetProjectAccessForTests,
  subscribeProjectAccess,
  withAccessTracking,
} from "./project-access"
import type { MintToken } from "./sync-adapter"

afterEach(() => resetProjectAccessForTests())

const minting = (result: Awaited<ReturnType<MintToken>>): MintToken => async () => result

describe("withAccessTracking", () => {
  it("marks a project unavailable on a mint 403 and passes the result through", async () => {
    const result = await withAccessTracking(minting({ token: null, status: 403 }))("p1", "f1")
    expect(result).toEqual({ token: null, status: 403 })
    expect(isProjectUnavailable("p1")).toBe(true)
    expect(isProjectUnavailable("p2")).toBe(false)
  })

  it("clears the mark on a successful mint", async () => {
    markProjectUnavailable("p1")
    await withAccessTracking(minting({ token: "tok", status: 200 }))("p1", "f1")
    expect(isProjectUnavailable("p1")).toBe(false)
  })

  it.each([401, 500, 503, null])("leaves the mark alone on status %s", async (status) => {
    markProjectUnavailable("p1")
    await withAccessTracking(minting({ token: null, status }))("p1", "f1")
    await withAccessTracking(minting({ token: null, status }))("p2", "f1")
    expect(isProjectUnavailable("p1")).toBe(true)
    expect(isProjectUnavailable("p2")).toBe(false)
  })
})

describe("subscriptions", () => {
  it("notifies only on change and keeps the snapshot stable between changes", () => {
    const cb = vi.fn()
    const unsubscribe = subscribeProjectAccess(cb)
    markProjectUnavailable("p1")
    const first = getUnavailableProjects()
    markProjectUnavailable("p1")
    expect(cb).toHaveBeenCalledTimes(1)
    expect(getUnavailableProjects()).toBe(first)
    expect(first).toEqual(["p1"])
    unsubscribe()
  })
})
