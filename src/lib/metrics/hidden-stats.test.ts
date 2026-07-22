import { beforeEach, describe, expect, it } from "vitest"
import {
  STAT_WIDGETS,
  loadHiddenStats,
  saveHiddenStats,
  toggleHiddenStat,
  type StatKey,
} from "./hidden-stats"

describe("hidden-stats (AQU-593)", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("defaults to nothing hidden when storage is empty", () => {
    expect(loadHiddenStats().size).toBe(0)
  })

  it("round-trips a hidden set through storage", () => {
    saveHiddenStats(new Set<StatKey>(["ai-drafted", "audio-validated"]))
    const loaded = loadHiddenStats()
    expect(loaded.has("ai-drafted")).toBe(true)
    expect(loaded.has("audio-validated")).toBe(true)
    expect(loaded.has("translated")).toBe(false)
  })

  it("toggle flips a key without mutating the input set", () => {
    const before = new Set<StatKey>(["translated"])
    const hidden = toggleHiddenStat(before, "validated")
    expect(hidden.has("validated")).toBe(true)
    expect(before.has("validated")).toBe(false) // input untouched
    const shown = toggleHiddenStat(hidden, "translated")
    expect(shown.has("translated")).toBe(false)
  })

  it("drops unknown keys from persisted storage (forward-compat)", () => {
    localStorage.setItem(
      "aquilla:hiddenStats",
      JSON.stringify(["validated", "some-removed-widget", 42]),
    )
    const loaded = loadHiddenStats()
    expect(loaded.has("validated")).toBe(true)
    expect(loaded.size).toBe(1)
  })

  it("returns an empty set for corrupt storage rather than throwing", () => {
    localStorage.setItem("aquilla:hiddenStats", "{not json")
    expect(loadHiddenStats().size).toBe(0)
  })

  it("every widget key is unique and stable", () => {
    const keys = STAT_WIDGETS.map((w) => w.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
