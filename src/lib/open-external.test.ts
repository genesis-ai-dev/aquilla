import { afterEach, describe, expect, it, vi } from "vitest"

const invoke = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke }))

import { openExternal } from "./open-external"

afterEach(() => {
  delete (window as unknown as { __TAURI__?: object }).__TAURI__
  vi.restoreAllMocks()
  invoke.mockReset()
})

describe("openExternal", () => {
  it("opens the system browser in the Tauri desktop app", async () => {
    ;(window as unknown as { __TAURI__?: object }).__TAURI__ = {}
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {})
    await openExternal("https://billing.stripe.com/session/x")
    expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", { url: "https://billing.stripe.com/session/x" })
    expect(assign).not.toHaveBeenCalled()
  })

  it("navigates the page in the browser SPA", async () => {
    const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {})
    await openExternal("https://billing.stripe.com/session/x")
    expect(assign).toHaveBeenCalledWith("https://billing.stripe.com/session/x")
    expect(invoke).not.toHaveBeenCalled()
  })
})
