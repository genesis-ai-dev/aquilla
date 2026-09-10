import { describe, expect, it } from "vitest"
import { resolveWorkbenchWindow } from "./workbench-window"

describe("resolveWorkbenchWindow", () => {
  it("centres the window on the focused cell and pads the read range on both sides", () => {
    const window = resolveWorkbenchWindow(30_000, 10_000, 80, 64)
    expect(window.start).toBe(9_960)
    expect(window.end).toBe(10_040)
    expect(window.readStart).toBe(9_896)
    expect(window.readEnd).toBe(10_104)
  })

  it("clamps to the start of the file without padding below zero", () => {
    const window = resolveWorkbenchWindow(30_000, 3, 80, 64)
    expect(window).toEqual({ start: 0, end: 80, readStart: 0, readEnd: 144 })
  })

  it("clamps to the end of the file so the window stays full", () => {
    const window = resolveWorkbenchWindow(30_000, 29_999, 80, 64)
    expect(window).toEqual({ start: 29_920, end: 30_000, readStart: 29_856, readEnd: 30_000 })
  })

  it("shows the whole file when it is smaller than the window", () => {
    expect(resolveWorkbenchWindow(21, 15, 80, 64)).toEqual({ start: 0, end: 21, readStart: 0, readEnd: 21 })
    expect(resolveWorkbenchWindow(0, 0, 80, 64)).toEqual({ start: 0, end: 0, readStart: 0, readEnd: 0 })
  })

  it("treats a missing focus (index below zero) as the top of the file", () => {
    expect(resolveWorkbenchWindow(500, -1, 80, 64)).toEqual({ start: 0, end: 80, readStart: 0, readEnd: 144 })
  })
})
