// AQU-2668 (Sam, Nov 19): Logic's fader scale, shared by the volume line's
// display and (once it moves over) the track header's fader: most of the
// height covers +6 to −20 dB, compressing toward −∞ at the bottom. And the
// one parser for a typed value.
import { describe, expect, it } from "vitest"
import { FADER_TICKS, faderDb, faderPos, formatDbValue, parseDbValue } from "./fader-scale"

describe("the fader scale", () => {
  it("puts +6 at the top and −∞ at the bottom", () => {
    expect(faderPos(6)).toBe(1)
    expect(faderPos(12)).toBe(1)
    expect(faderPos(-Infinity)).toBe(0)
    expect(faderDb(1)).toBe(6)
    expect(faderDb(0)).toBe(-Infinity)
  })

  it("gives most of the height to +6 … −20 dB", () => {
    expect(faderPos(6) - faderPos(-20)).toBeGreaterThanOrEqual(0.65)
    expect(faderPos(-60)).toBeLessThan(0.06)
  })

  it("rises with the level, and dB ↔ position round-trips", () => {
    const dbs = [6, 3, 0, -1.5, -3, -6, -10, -15, -20, -25, -30, -40, -50, -60, -80, -120]
    for (let i = 1; i < dbs.length; i++) expect(faderPos(dbs[i])).toBeLessThan(faderPos(dbs[i - 1]))
    for (const db of dbs) expect(faderDb(faderPos(db))).toBeCloseTo(db, 6)
  })

  it("has the usual ticks, labelled", () => {
    expect(FADER_TICKS.map((t) => t.db)).toEqual([6, 0, -3, -6, -10, -15, -20, -30, -40, -60, -Infinity])
    expect(FADER_TICKS.map((t) => t.label)).toEqual(["+6", "0", "−3", "−6", "−10", "−15", "−20", "−30", "−40", "−60", "−∞"])
    for (const t of FADER_TICKS) expect(t.pos).toBe(faderPos(t.db))
  })
})

describe("typing a value", () => {
  it("reads numbers with either minus sign, a plus, a comma, and an optional dB", () => {
    expect(parseDbValue("−3.5")).toBe(-3.5)
    expect(parseDbValue("-3.5")).toBe(-3.5)
    expect(parseDbValue(" -3,5 dB ")).toBe(-3.5)
    expect(parseDbValue("+2")).toBe(2)
    expect(parseDbValue("0")).toBe(0)
    expect(parseDbValue(".5")).toBe(0.5)
    expect(parseDbValue("–12")).toBe(-12)
  })

  it("reads silence as −∞, written with a sign", () => {
    for (const t of ["-inf", "−inf", "−∞", "-∞", "-Infinity", "−INF dB"]) expect(parseDbValue(t)).toBe(-Infinity)
  })

  it("clamps to +6 at the top", () => {
    expect(parseDbValue("9")).toBe(6)
    expect(parseDbValue("+inf")).toBe(6)
    expect(parseDbValue("+∞")).toBe(6)
  })

  it("rejects junk, and an infinity with no sign", () => {
    for (const t of ["", "  ", "abc", "3.5.2", "--3", "-", "inf", "∞", "3 4", "6dbx", "NaN"]) expect(parseDbValue(t)).toBeNull()
  })

  it("writes a value the way it is typed back", () => {
    expect(formatDbValue(-Infinity)).toBe("−∞ dB")
    expect(formatDbValue(-3.5)).toBe("−3.5 dB")
    expect(formatDbValue(2)).toBe("+2.0 dB")
    expect(formatDbValue(0)).toBe("0.0 dB")
    for (const db of [-Infinity, -3.5, 2, 0]) expect(parseDbValue(formatDbValue(db))).toBe(db)
  })
})
