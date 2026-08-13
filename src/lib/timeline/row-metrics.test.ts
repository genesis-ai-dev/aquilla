import { describe, it, expect } from "vitest"
import {
  ROW_H_MIN,
  ROW_H_DEFAULT,
  ROW_H_MAX,
  MIN_CHIP_LABEL_H_PX,
  chipPadPx,
  chipHeightPx,
  clampRowHeight,
} from "./row-metrics"

describe("row-metrics", () => {
  // THE non-negotiable guard of this round. Nine hard-coded class sites (four
  // `h-[66px]` rows, five `top-2.5 h-[46px]` chip boxes) become two shared
  // constants driven by these two functions, and the failure mode of getting
  // the ramp slightly wrong is that EVERY row shifts a few pixels with nothing
  // red anywhere — no test asserts those numbers, and the browser passes only
  // click things. So they get asserted here, literally.
  it("reproduces the shipped row exactly at the default height", () => {
    expect(chipPadPx(ROW_H_DEFAULT)).toBe(10)
    expect(chipHeightPx(ROW_H_DEFAULT)).toBe(46)
    // 10 + 46 + 10 = 66: the padding is symmetric and the row is fully spent.
    expect(chipPadPx(ROW_H_DEFAULT) * 2 + chipHeightPx(ROW_H_DEFAULT)).toBe(ROW_H_DEFAULT)
  })

  it("clamps a row height to both ends and always answers an integer", () => {
    expect(clampRowHeight(ROW_H_MIN - 40)).toBe(ROW_H_MIN)
    expect(clampRowHeight(ROW_H_MAX + 400)).toBe(ROW_H_MAX)
    expect(clampRowHeight(ROW_H_DEFAULT)).toBe(ROW_H_DEFAULT)
    // Integers are mandatory: a row on a half pixel blurs the 1px border-b on
    // every lane and every gutter label.
    expect(clampRowHeight(48.5)).toBe(49)
    expect(clampRowHeight(48.4)).toBe(48)
    for (const n of [24.5, 31.2, 66.7, 99.99, 159.5]) {
      expect(Number.isInteger(clampRowHeight(n))).toBe(true)
    }
  })

  it("really is a bare band at the compact end", () => {
    // Ties the constants to the promise: at ROW_H_MIN the chip is under the
    // label gate, so it draws colour and nothing else. Nudge ROW_H_MIN up
    // without thinking and this fails rather than silently reintroducing the
    // clipped half-line of text the compact band exists to avoid.
    expect(chipHeightPx(ROW_H_MIN)).toBeLessThan(MIN_CHIP_LABEL_H_PX)
  })
})
