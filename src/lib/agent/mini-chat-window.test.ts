// AQU-1651: the floating mini-chat's only persistent state is where the reader
// parked it and whether they left it collapsed. These tests encode what makes
// that safe: a window remembered from a big monitor must still be reachable on
// a laptop, a window bigger than the viewport keeps its top-left (and so its
// drag handle and close button) on screen, and a corrupt stored position is
// discarded without also forgetting the minimized state.

import { beforeEach, describe, expect, it } from "vitest"
import {
  MINI_CHAT_BAR_SIZE,
  MINI_CHAT_EDGE_MARGIN,
  MINI_CHAT_WINDOW_SIZE,
  clampMiniChatPoint,
  defaultMiniChatPoint,
  miniChatSize,
  readMiniChatPlacement,
  writeMiniChatPlacement,
} from "./mini-chat-window"

const OWNER = "proj-1:ada"
const DESKTOP = { width: 1440, height: 900 }

beforeEach(() => {
  localStorage.clear()
})

describe("clampMiniChatPoint", () => {
  it("leaves a point that already fits alone", () => {
    expect(clampMiniChatPoint({ x: 400, y: 200 }, MINI_CHAT_WINDOW_SIZE, DESKTOP)).toEqual({ x: 400, y: 200 })
  })

  it("pulls a window parked past the right or bottom edge back into view", () => {
    const point = clampMiniChatPoint({ x: 5000, y: 5000 }, MINI_CHAT_WINDOW_SIZE, DESKTOP)
    expect(point.x).toBe(DESKTOP.width - MINI_CHAT_WINDOW_SIZE.width - MINI_CHAT_EDGE_MARGIN)
    expect(point.y).toBe(DESKTOP.height - MINI_CHAT_WINDOW_SIZE.height - MINI_CHAT_EDGE_MARGIN)
  })

  it("keeps the top-left reachable when the window is larger than the viewport", () => {
    // Narrower and shorter than the window itself: the upper bound falls below
    // the margin, and pinning to the margin is what keeps the header — the
    // drag handle, minimize and close — on screen.
    const tiny = { width: 300, height: 320 }
    expect(clampMiniChatPoint({ x: 900, y: 900 }, MINI_CHAT_WINDOW_SIZE, tiny)).toEqual({
      x: MINI_CHAT_EDGE_MARGIN,
      y: MINI_CHAT_EDGE_MARGIN,
    })
  })

  it("treats a non-finite coordinate as the margin rather than propagating NaN", () => {
    // A NaN left/top would place the window nowhere at all; infinity would
    // only look like "far off-screen" if it survived the clamp. Both are
    // corrupt input, and both resolve to the safe corner.
    expect(clampMiniChatPoint({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, MINI_CHAT_BAR_SIZE, DESKTOP)).toEqual({
      x: MINI_CHAT_EDGE_MARGIN,
      y: MINI_CHAT_EDGE_MARGIN,
    })
  })
})

describe("miniChatSize", () => {
  it("reports the bar's box when minimized and the window's otherwise", () => {
    expect(miniChatSize(true)).toEqual(MINI_CHAT_BAR_SIZE)
    expect(miniChatSize(false)).toEqual(MINI_CHAT_WINDOW_SIZE)
  })
})

describe("defaultMiniChatPoint", () => {
  it("rests in the lower-right, clear of the editor's reading column", () => {
    const point = defaultMiniChatPoint(MINI_CHAT_WINDOW_SIZE, DESKTOP)
    // Right-hand side, and resting ON the bottom edge — the window is taller
    // than half the viewport, so "lower" is about its bottom, not its top.
    expect(point.x).toBeGreaterThan(DESKTOP.width / 2)
    expect(point.x + MINI_CHAT_WINDOW_SIZE.width).toBeLessThanOrEqual(DESKTOP.width)
    expect(point.y + MINI_CHAT_WINDOW_SIZE.height).toBeLessThanOrEqual(DESKTOP.height)
    expect(DESKTOP.height - (point.y + MINI_CHAT_WINDOW_SIZE.height)).toBeLessThanOrEqual(MINI_CHAT_EDGE_MARGIN * 2)
  })
})

describe("placement storage", () => {
  it("round-trips a placement for one owner", () => {
    writeMiniChatPlacement(OWNER, { x: 120, y: 64, minimized: true })
    expect(readMiniChatPlacement(OWNER, DESKTOP)).toEqual({ x: 120, y: 64, minimized: true })
  })

  it("keeps each project/user pair's window separate", () => {
    writeMiniChatPlacement(OWNER, { x: 120, y: 64, minimized: true })
    const other = readMiniChatPlacement("proj-2:ada", DESKTOP)
    expect(other.minimized).toBe(false)
    expect(other).toEqual({ ...defaultMiniChatPoint(MINI_CHAT_WINDOW_SIZE, DESKTOP), minimized: false })
  })

  it("re-clamps a position stored on a larger screen", () => {
    writeMiniChatPlacement(OWNER, { x: 2400, y: 1300, minimized: false })
    const laptop = { width: 1280, height: 720 }
    const placement = readMiniChatPlacement(OWNER, laptop)
    expect(placement.x + MINI_CHAT_WINDOW_SIZE.width).toBeLessThanOrEqual(laptop.width)
    expect(placement.y + MINI_CHAT_WINDOW_SIZE.height).toBeLessThanOrEqual(laptop.height)
  })

  it("clamps a minimized placement against the BAR's box, not the window's", () => {
    // The bar is much shorter, so it may legitimately rest lower than a window
    // could. Clamping it as though it were the window would jump it upward.
    writeMiniChatPlacement(OWNER, { x: 10_000, y: 10_000, minimized: true })
    const placement = readMiniChatPlacement(OWNER, DESKTOP)
    expect(placement.y).toBe(DESKTOP.height - MINI_CHAT_BAR_SIZE.height - MINI_CHAT_EDGE_MARGIN)
  })

  it("falls back to the default corner when nothing is stored", () => {
    expect(readMiniChatPlacement(OWNER, DESKTOP)).toEqual({
      ...defaultMiniChatPoint(MINI_CHAT_WINDOW_SIZE, DESKTOP),
      minimized: false,
    })
  })

  it("discards an unusable stored position but still honours the minimized flag", () => {
    localStorage.setItem(`aq.agent-mini-chat.v1:${OWNER}`, JSON.stringify({ x: "left", y: null, minimized: true }))
    const placement = readMiniChatPlacement(OWNER, DESKTOP)
    expect(placement.minimized).toBe(true)
    expect(placement).toEqual({ ...defaultMiniChatPoint(MINI_CHAT_BAR_SIZE, DESKTOP), minimized: true })
  })

  it("survives an unparseable stored value", () => {
    localStorage.setItem(`aq.agent-mini-chat.v1:${OWNER}`, "{not json")
    expect(readMiniChatPlacement(OWNER, DESKTOP)).toEqual({
      ...defaultMiniChatPoint(MINI_CHAT_WINDOW_SIZE, DESKTOP),
      minimized: false,
    })
  })

  it("never writes a non-finite position", () => {
    writeMiniChatPlacement(OWNER, { x: Number.NaN, y: 10, minimized: false })
    expect(localStorage.getItem(`aq.agent-mini-chat.v1:${OWNER}`)).toBeNull()
  })
})
