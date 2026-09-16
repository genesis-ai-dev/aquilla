import { describe, it, expect } from "vitest"
import {
  ROW_H_MIN,
  ROW_H_DEFAULT,
  ROW_H_MAX,
  MIN_CHIP_LABEL_H_PX,
  SLOT_BUTTON_MAX_PX,
  SLOT_BUTTON_MIN_PX,
  FOLDER_ROW_H_PX,
  chipPadPx,
  chipHeightPx,
  clampRowHeight,
  folderRowHPx,
  slotButtonPx,
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

// THE RULE (Sam, 2026-08-14): the hover record/add button scales with the ROW,
// which every slot on that row shares, and never with its own REGION's width,
// which is per-chip. Sizing on width drew a 20px circle beside a 28px one and
// made a single control read as several down one track.
describe("slotButtonPx", () => {
  it("gives the same circle to a sliver and to a wide-open stretch", () => {
    // The whole point, and the reason the width parameter is gone rather than
    // merely unused: a signature that still accepted it would invite it back.
    expect(slotButtonPx(chipHeightPx(ROW_H_DEFAULT))).toBe(SLOT_BUTTON_MAX_PX)
    expect(slotButtonPx.length).toBe(1)
  })

  it("hands back exactly the size the button was hard-coded to, at the default row", () => {
    // 46px of chip. Nothing about a normal timeline may have moved.
    expect(slotButtonPx(46)).toBe(28)
  })

  it("shrinks with row height, because every slot on the row shrinks together", () => {
    expect(slotButtonPx(30)).toBe(26)
    expect(slotButtonPx(24)).toBe(20)
    // Monotonic: a shorter row never yields a bigger button.
    for (const [tall, short] of [[46, 32], [32, 26], [26, 20]] as const) {
      expect(slotButtonPx(tall)).toBeGreaterThanOrEqual(slotButtonPx(short))
    }
  })

  it("stops at the floor rather than vanishing", () => {
    // Below a 16px target the circle is smaller than the pointer that has to
    // hit it — and this is the only way to record into an empty stretch.
    expect(slotButtonPx(chipHeightPx(ROW_H_MIN))).toBe(SLOT_BUTTON_MIN_PX)
    expect(slotButtonPx(0)).toBe(SLOT_BUTTON_MIN_PX)
  })

  it("never exceeds the max, however tall the row", () => {
    expect(slotButtonPx(chipHeightPx(ROW_H_MAX))).toBe(SLOT_BUTTON_MAX_PX)
  })

  it("falls back to the full size on a junk height rather than a floor", () => {
    expect(slotButtonPx(Number.NaN)).toBe(SLOT_BUTTON_MAX_PX)
  })
})

// AQU-646 stage 4b: folders are slim fixed headings, never taller than the
// tracks around them.
describe("folderRowHPx", () => {
  it("is a fixed 28px heading at the default dial — and stays 28 however tall the dial goes", () => {
    expect(folderRowHPx(ROW_H_DEFAULT)).toBe(FOLDER_ROW_H_PX)
    expect(folderRowHPx(ROW_H_MAX)).toBe(FOLDER_ROW_H_PX)
  })

  it("never stands taller than the tracks: at the 24px dial floor it is 24 too", () => {
    // Sam's clamp ruling — at extreme compression everything gets uniformly
    // small; a heading sticking up above the rows it is "less than" would
    // invert the hierarchy it exists to express.
    expect(folderRowHPx(ROW_H_MIN)).toBe(ROW_H_MIN)
  })

  it("answers through the dial's own clamp on junk input", () => {
    // clampRowHeight turns non-finite into the 66px default, and 66 > 28.
    expect(folderRowHPx(Number.NaN)).toBe(FOLDER_ROW_H_PX)
    // A sub-floor dial value clamps up to 24 first, then wins against 28.
    expect(folderRowHPx(1)).toBe(ROW_H_MIN)
  })
})
