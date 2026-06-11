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
  it("defaults to left when unset", () => {
    expect(getDockRailPosition()).toBe("left")
  })

  it("persists top position", () => {
    setDockRailPosition("top")
    expect(getDockRailPosition()).toBe("top")
    expect(localStorage.getItem("codex:dockRailPosition")).toBe("top")
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
