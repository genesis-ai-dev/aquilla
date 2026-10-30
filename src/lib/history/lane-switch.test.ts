// Decision 11, gaps 24 and 29: undoing a step made in another language opens
// that language first, unless the person can no longer work in it.
import { describe, it, expect, vi, afterEach } from "vitest"
import { laneAccessFor, laneShownReady, waitUntilReady } from "./lane-switch"

const base = { available: ["", "sw", "fr"], scoped: null, archived: [], canSwitch: true, loaded: true }

describe("opening a step's language", () => {
  it("opens any language the switcher offers", () => {
    expect(laneAccessFor("sw", base)).toBe("ok")
  })

  it("drops the step when the language was removed, archived, or is outside the person's limit", () => {
    expect(laneAccessFor("de", base)).toBe("denied")
    expect(laneAccessFor("sw", { ...base, archived: ["sw"] })).toBe("denied")
    expect(laneAccessFor("fr", { ...base, scoped: ["sw"], canSwitch: false })).toBe("denied")
    expect(laneAccessFor("sw", { ...base, scoped: ["sw"], canSwitch: false })).toBe("ok")
  })

  // Review, Oct 29: Cmd+Z pressed as the project opens, before its languages
  // have loaded, must not throw away a step made in French.
  it("keeps the step waiting while the project's languages are still loading", () => {
    expect(laneAccessFor("fr", { ...base, available: [""], loaded: false })).toBe("blocked")
  })

  it("keeps the step waiting for someone who cannot switch languages here", () => {
    expect(laneAccessFor("fr", { ...base, canSwitch: false })).toBe("blocked")
  })
})

// Review, Oct 29: the line store re-sorts its rows for a new language one
// effect pass after the switcher changes, and the loaded flags of a read that
// isn't running say "loaded" for any language. Neither may count until the
// rows are sorted for the language asked for.
describe("the language is on screen", () => {
  it("only once the lines are sorted for it, not on flags left from the one before", () => {
    expect(laneShownReady("fr", { open: "fr", storeLane: "sw", loaded: true })).toBe(false)
    expect(laneShownReady("fr", { open: "fr", storeLane: "fr", loaded: false })).toBe(false)
    expect(laneShownReady("fr", { open: "fr", storeLane: "fr", loaded: true })).toBe(true)
  })
})

describe("waiting for the language to load", () => {
  afterEach(() => vi.useRealTimers())

  it("is ready once the language has loaded on two checks in a row", async () => {
    vi.useFakeTimers()
    let loaded = false
    const done = waitUntilReady(() => loaded, 1000, 50)
    await vi.advanceTimersByTimeAsync(100)
    loaded = true
    await vi.advanceTimersByTimeAsync(100)
    await expect(done).resolves.toBe("ready")
  })

  it("gives up and keeps the step when it never loads", async () => {
    vi.useFakeTimers()
    const done = waitUntilReady(() => false, 300, 50)
    await vi.advanceTimersByTimeAsync(400)
    await expect(done).resolves.toBe("blocked")
  })
})
