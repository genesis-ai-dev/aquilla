import { describe, it, expect, beforeEach } from "vitest"
import {
  getDockRailPosition,
  setDockRailPosition,
  onDockRailPositionChange,
} from "./dock-rail-position"

beforeEach(() => {
  localStorage.clear()
})

describe("dock-rail-position", () => {
  it("defaults to top when unset", () => {
    expect(getDockRailPosition()).toBe("top")
  })

  it("persists left position", () => {
    setDockRailPosition("left")
    expect(getDockRailPosition()).toBe("left")
    expect(localStorage.getItem("codex:dockRailPosition")).toBe("left")
  })

  it("notifies listeners on change", () => {
    const seen: string[] = []
    const off = onDockRailPositionChange((p) => seen.push(p))
    setDockRailPosition("top")
    setDockRailPosition("left")
    off()
    expect(seen).toEqual(["top", "left"])
  })
})
