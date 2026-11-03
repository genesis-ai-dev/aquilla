// AQU-2327: the Station is a tab beside the text (Sam, Oct 28).
import { afterEach, describe, expect, it } from "vitest"
import { dockView, readStoredDock, startDockLayout } from "./media-dock-layout"

describe("the Station's place in the dock", () => {
  afterEach(() => localStorage.clear())

  it("starts as a tab behind the text, which stays the shown tab", () => {
    const l = startDockLayout()
    expect(l.areas.lr).toEqual(["text", "station"])
    expect(l.active.lr).toBe("text")
    const v = dockView(l, { film: true })
    expect(v.present).toContain("station")
    expect(v.isShowing("station")).toBe(false)
  })

  it("an arrangement saved before it existed gains it beside the text, wherever the text is", () => {
    localStorage.setItem("aquilla:mediaDock:f1", JSON.stringify({ areas: { ll: ["text"], lr: ["film"] }, active: { ll: "text", lr: "film" } }))
    const l = readStoredDock("f1")!
    expect(l.areas.ll).toEqual(["text", "station"])
    expect(l.active.ll).toBe("text")
  })

  it("a caller can leave it out", () => {
    expect(dockView(startDockLayout(), { film: false, station: false }).present).toEqual(["text"])
  })
})
