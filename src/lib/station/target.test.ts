import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetStationTargetForTests, getStationTarget, onStationShowRequest, openInStation } from "./target"

describe("the Station's open recording", () => {
  afterEach(() => __resetStationTargetForTests())

  it("opens a take and, when asked, asks for its tab to show", () => {
    const show = vi.fn()
    onStationShowRequest(show)
    openInStation({ fileId: "f", cellId: "c", audioId: "a.webm" })
    expect(getStationTarget()).toEqual({ fileId: "f", cellId: "c", audioId: "a.webm" })
    expect(show).not.toHaveBeenCalled()
    openInStation({ fileId: "f", cellId: "c", audioId: "a.webm" }, { show: true })
    expect(show).toHaveBeenCalledTimes(1)
  })

  // Found in the browser (Oct 30): "Edit in the Station" froze the page. The
  // workspace's listener shows the tab inside a flushSync, its effect then
  // re-subscribes a NEW listener, and the walk over the live Set reached it,
  // and the next one, forever.
  it("asks each listener once, even when one re-subscribes while it runs", () => {
    let calls = 0
    let off: () => void = () => {}
    const listen = () => {
      calls += 1
      if (calls > 50) throw new Error("called again and again")
      off()
      off = onStationShowRequest(listen)
    }
    off = onStationShowRequest(listen)
    openInStation({ fileId: "f", cellId: "c", audioId: "a.webm" }, { show: true })
    expect(calls).toBe(1)
  })
})
