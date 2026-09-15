import { describe, expect, it } from "vitest"
import { formatBuildDay, formatBuildInfo, formatBuildLabel } from "./build-label"

describe("formatBuildLabel", () => {
  const base = { version: "0.1.2", sha: "abc1234", builtAt: "2026-08-27T12:23:21.000Z" }

  it("dates the build next to the commit hash (AQU-1023)", () => {
    expect(formatBuildLabel({ ...base, branch: "dev" })).toBe("v0.1.2 · dev · abc1234 · 2026-08-27")
  })

  it("drops the branch on the production line but keeps the date", () => {
    expect(formatBuildLabel({ ...base, branch: "main" })).toBe("v0.1.2 · abc1234 · 2026-08-27")
    expect(formatBuildLabel({ ...base, branch: "production" })).toBe("v0.1.2 · abc1234 · 2026-08-27")
  })

  it("omits the date rather than rendering a placeholder when it is unknown", () => {
    expect(formatBuildLabel({ ...base, branch: "dev", builtAt: "" })).toBe("v0.1.2 · dev · abc1234")
  })
})

describe("formatBuildDay", () => {
  it("reads the same in every timezone (UTC calendar day)", () => {
    // 2026-08-27T23:30Z is already the 28th in Sydney; the label must not drift.
    expect(formatBuildDay("2026-08-27T23:30:00.000Z")).toBe("2026-08-27")
  })

  it("returns nothing for a missing or unparseable timestamp", () => {
    expect(formatBuildDay("bogus")).toBe("")
    expect(formatBuildDay("")).toBe("")
  })
})

describe("formatBuildInfo", () => {
  it("carries the exact build coordinates for copy/paste", () => {
    expect(
      formatBuildInfo({
        version: "0.1.2",
        branch: "dev",
        sha: "abc1234",
        builtAt: "2026-08-27T12:23:21.000Z",
      }),
    ).toBe("v0.1.2 · dev · abc1234 · 2026-08-27\nbuild: dev@abc1234\ndate: 2026-08-27T12:23:21.000Z")
  })

  it("omits the date line when the build date is unknown", () => {
    expect(
      formatBuildInfo({ version: "0.1.2", branch: "unknown", sha: "unknown", builtAt: "" }),
    ).toBe("v0.1.2 · unknown · unknown\nbuild: unknown@unknown")
  })
})
