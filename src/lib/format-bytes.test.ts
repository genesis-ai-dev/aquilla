import { describe, it, expect } from "vitest"
import { formatMB, formatBytesProgress } from "./format-bytes"

const MB = 1024 * 1024

describe("formatMB", () => {
  it("renders a one-decimal megabyte string", () => {
    expect(formatMB(40 * MB)).toBe("40.0 MB")
    expect(formatMB(12.4 * MB)).toBe("12.4 MB")
    expect(formatMB(1.5 * MB)).toBe("1.5 MB")
  })

  it("renders 0.0 MB at zero and clamps negatives", () => {
    expect(formatMB(0)).toBe("0.0 MB")
    expect(formatMB(-5)).toBe("0.0 MB")
  })
})

describe("formatBytesProgress (AQU-520)", () => {
  it("shows transferred / total MB with a percentage when the total is known", () => {
    expect(formatBytesProgress(12.4 * MB, 40 * MB)).toBe("12.4 / 40.0 MB (31%)")
  })

  it("shows the total from the very start (received 0, total known)", () => {
    expect(formatBytesProgress(0, 40 * MB)).toBe("0.0 / 40.0 MB (0%)")
  })

  it("shows 100% when transfer completes", () => {
    expect(formatBytesProgress(40 * MB, 40 * MB)).toBe("40.0 / 40.0 MB (100%)")
  })

  it("shows only transferred-so-far when the total is unknown — no misleading total", () => {
    expect(formatBytesProgress(12.4 * MB, undefined)).toBe("12.4 MB")
    expect(formatBytesProgress(12.4 * MB, 0)).toBe("12.4 MB")
  })

  it("treats a missing received count as 0", () => {
    expect(formatBytesProgress(undefined, 40 * MB)).toBe("0.0 / 40.0 MB (0%)")
    expect(formatBytesProgress(undefined, undefined)).toBe("0.0 MB")
  })
})
