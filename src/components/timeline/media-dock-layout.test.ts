import { beforeEach, describe, expect, it } from "vitest"
import {
  canRestore,
  dockView,
  enterFullScreen,
  foldRegion,
  fullScreenRegion,
  movePanel,
  readStoredDock,
  restoreFromFullScreen,
  showPanel,
  startDockLayout,
  undoTargets,
  unfoldRegion,
  writeStoredDock,
} from "./media-dock-layout"

const FILM = { film: true }
const NO_FILM = { film: false }

describe("the docking model", () => {
  it("starts with the film bottom left and the text bottom right, nothing folded", () => {
    const v = dockView(startDockLayout(), FILM)
    expect(v.list("ll")).toEqual(["film"])
    expect(v.list("lr")).toEqual(["text"])
    expect(v.openRegions).toEqual(["tl", "ll", "lr"])
  })

  it("an area with no panel on this file does not exist, and is never open", () => {
    const v = dockView(startDockLayout(), NO_FILM)
    expect(v.exists("ll")).toBe(false)
    expect(v.openRegions).toEqual(["tl", "lr"])
  })

  it("folds a region, but never the last one open", () => {
    let l = foldRegion(startDockLayout(), FILM, "ll")
    l = foldRegion(l, FILM, "lr")
    expect(dockView(l, FILM).openRegions).toEqual(["tl"])
    expect(foldRegion(l, FILM, "tl")).toBe(l)
  })

  it("moving a panel to an area that has one makes tabs; the emptied area goes", () => {
    const l = movePanel(startDockLayout(), "text", "ll")
    const v = dockView(l, FILM)
    expect(v.list("ll")).toEqual(["film", "text"])
    expect(v.activeOf("ll")).toBe("text")
    expect(v.exists("lr")).toBe(false)
    expect(v.isShowing("film")).toBe(false)
    expect(dockView(showPanel(l, "film"), FILM).isShowing("film")).toBe(true)
  })

  describe("full screen is folds, with a note of what it folded", () => {
    it("folds every other open region and the left panel, and restores exactly that", () => {
      const start = foldRegion(startDockLayout(), FILM, "lr") // the text already folded by hand
      const { layout, foldLeft } = enterFullScreen(start, FILM, "tl", "files")
      expect(foldLeft).toBe(true)
      const v = dockView(layout, FILM)
      expect(v.openRegions).toEqual(["tl"])
      expect(fullScreenRegion(v, true)).toBe("tl")
      expect(canRestore(v, true)).toBe(true)
      expect(undoTargets(layout)).toEqual(["ll", "left"])
      const back = restoreFromFullScreen(layout)
      expect(back.leftTab).toBe("files")
      // The text stays folded: full screen never folded it.
      expect(dockView(back.layout, FILM).openRegions).toEqual(["tl", "ll"])
      expect(back.layout.fullUndo).toEqual([])
    })

    it("is not full screen while the left panel is open", () => {
      const { layout } = enterFullScreen(startDockLayout(), FILM, "lr", null)
      expect(fullScreenRegion(dockView(layout, FILM), false)).toBeNull()
      expect(fullScreenRegion(dockView(layout, FILM), true)).toBe("lr")
    })

    it("showing or unfolding anything else ends it and drops the note", () => {
      const { layout } = enterFullScreen(startDockLayout(), FILM, "tl", "files")
      expect(showPanel(layout, "film").fullUndo).toEqual([])
      expect(unfoldRegion(layout, "lr").fullUndo).toEqual([])
      expect(movePanel(layout, "text", "ll").fullUndo).toEqual([])
    })

    it("switching tabs inside the full-screen area keeps it", () => {
      const tabs = movePanel(startDockLayout(), "text", "ll")
      const { layout } = enterFullScreen(tabs, FILM, "ll", null)
      expect(showPanel(layout, "film").fullUndo).toEqual(["tl"])
    })
  })

  describe("storage, per file", () => {
    beforeEach(() => localStorage.clear())

    it("round-trips, and reads nothing for a file never arranged", () => {
      expect(readStoredDock("f1")).toBeNull()
      const l = movePanel(foldRegion(startDockLayout(), FILM, "tl"), "text", "ll")
      writeStoredDock("f1", l)
      expect(readStoredDock("f1")).toEqual(l)
      expect(readStoredDock("f2")).toBeNull()
      writeStoredDock("f1", null)
      expect(readStoredDock("f1")).toBeNull()
    })

    it("puts a panel lost to a bad write back home, and drops junk", () => {
      localStorage.setItem(
        "aquilla:mediaDock:f1",
        JSON.stringify({ areas: { ll: ["film", "nope"], lr: ["film"] }, folded: { tl: "yes" }, fullUndo: ["ll", 3, "left:files"] }),
      )
      const l = readStoredDock("f1")!
      expect(l.areas).toEqual({ ll: ["film"], lr: ["text"] })
      expect(l.folded.tl).toBe(false)
      expect(l.fullUndo).toEqual(["ll", "left:files"])
      localStorage.setItem("aquilla:mediaDock:f1", "{not json")
      expect(readStoredDock("f1")).toBeNull()
    })
  })
})
