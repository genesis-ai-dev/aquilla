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
})
