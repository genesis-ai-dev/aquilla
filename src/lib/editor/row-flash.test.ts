import { describe, it, expect, beforeEach } from "vitest"
import {
  ROW_FLASH_ATTR, ROW_FLASH_MS, ROW_FLASH_WAIT_MS, rowInView, startRowFlash, type RowFlashClock,
} from "./row-flash"

/** A clock the test drives by hand: frames and timers run only when told. */
function manualClock() {
  let t = 0
  let seq = 0
  const frames = new Map<number, () => void>()
  const timers = new Map<number, { at: number; cb: () => void }>()
  const clock: RowFlashClock = {
    raf: (cb) => { const id = ++seq; frames.set(id, cb); return id },
    cancelRaf: (id) => { frames.delete(id) },
    now: () => t,
    setTimeout: (cb, ms) => { const id = ++seq; timers.set(id, { at: t + ms, cb }); return id },
    clearTimeout: (id) => { timers.delete(id) },
  }
  return {
    clock,
    /** Advance one 16ms frame. */
    frame() {
      t += 16
      const due = [...frames.entries()]
      frames.clear()
      for (const [, cb] of due) cb()
      for (const [id, timer] of [...timers]) if (timer.at <= t) { timers.delete(id); timer.cb() }
    },
    advance(ms: number) { const end = t + ms; while (t < end) this.frame() },
    pendingFrames: () => frames.size,
  }
}

/** Give an element a fixed on-screen box. */
function placeAt(el: HTMLElement, top: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
}

let list: HTMLElement
beforeEach(() => {
  document.body.innerHTML = ""
  list = document.createElement("div")
  document.body.appendChild(list)
  placeAt(list, 0, 800)
})

function addRow(cellId: string, top: number) {
  const row = document.createElement("div")
  row.setAttribute("data-cell-id", cellId)
  placeAt(row, top, 80)
  list.appendChild(row)
  return row
}

describe("startRowFlash (AQU-1493)", () => {
  it("waits for a row the list has not drawn yet, then pulses it", () => {
    const c = manualClock()
    startRowFlash(() => list, "c1", c.clock)
    c.frame()
    c.frame()
    const row = addRow("c1", 300)
    c.frame()
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(true)
  })

  it("does not pulse a row still off screen, and pulses it once it scrolls in", () => {
    // A row far down the file is first drawn at its ESTIMATED offset, out of
    // sight, and only reaches the screen once the list settles.
    const c = manualClock()
    const row = addRow("c1", 21_000)
    startRowFlash(() => list, "c1", c.clock)
    c.advance(200)
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(false)
    placeAt(row, 360, 80)
    c.frame()
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(true)
  })

  it("pulses a row that never comes on screen once the wait runs out, and gives up on one that never appears", () => {
    const c = manualClock()
    const far = addRow("far", 21_000)
    startRowFlash(() => list, "far", c.clock)
    startRowFlash(() => list, "missing", c.clock)
    c.advance(ROW_FLASH_WAIT_MS + 32)
    expect(far.hasAttribute(ROW_FLASH_ATTR)).toBe(true)
    // Both have stopped looking.
    expect(c.pendingFrames()).toBe(0)
  })

  it("takes the pulse off when it has run", () => {
    const c = manualClock()
    const row = addRow("c1", 300)
    startRowFlash(() => list, "c1", c.clock)
    c.frame()
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(true)
    c.advance(ROW_FLASH_MS + 16)
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(false)
  })

  it("is an attribute, so a rewrite of the row's className leaves it alone", () => {
    const c = manualClock()
    const row = addRow("c1", 300)
    row.className = "relative"
    startRowFlash(() => list, "c1", c.clock)
    c.frame()
    // What React does when the row's className prop changes.
    row.className = "relative group/rowstrip"
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(true)
  })

  it("cancel stops the wait and takes a running pulse off its row", () => {
    const c = manualClock()
    const cancelWaiting = startRowFlash(() => list, "later", c.clock)
    cancelWaiting()
    const later = addRow("later", 300)
    c.frame()
    expect(later.hasAttribute(ROW_FLASH_ATTR)).toBe(false)

    const row = addRow("c1", 100)
    const cancel = startRowFlash(() => list, "c1", c.clock)
    c.frame()
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(true)
    cancel()
    expect(row.hasAttribute(ROW_FLASH_ATTR)).toBe(false)
  })
})

describe("rowInView", () => {
  it("measures the row against the list's visible area", () => {
    expect(rowInView(addRow("a", 300), list)).toBe(true)
    expect(rowInView(addRow("b", 900), list)).toBe(false)
    expect(rowInView(addRow("c", -200), list)).toBe(false)
  })

  it("counts a row as visible when the list has no size to measure against", () => {
    placeAt(list, 0, 0)
    expect(rowInView(addRow("a", 5_000), list)).toBe(true)
  })
})
