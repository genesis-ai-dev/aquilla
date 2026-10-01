import { describe, expect, it } from "vitest"
import {
  formatBuildDay,
  formatBuildInfo,
  formatBuildLabel,
  formatBuildRailLabel,
} from "./build-label"

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

describe("formatBuildRailLabel (AQU-1523)", () => {
  const base = { version: "0.1.2", sha: "abc1234", builtAt: "2026-08-27T12:23:21.000Z" }

  it("keeps version, sha and date — the three fields support reads off a screenshot", () => {
    expect(formatBuildRailLabel({ ...base, branch: "dev" })).toBe("v0.1.2 · abc1234 · 2026-08-27")
  })

  it("drops the branch in every environment, not just production", () => {
    // The 42-char branch of a preview build is exactly what starved the label
    // to "v0" in a 224px rail; the rail label must not depend on its length.
    const long = formatBuildRailLabel({
      ...base,
      branch: "agent/AQU-1523-sidebar-footer-feedback-row",
    })
    expect(long).toBe("v0.1.2 · abc1234 · 2026-08-27")
    expect(long).toBe(formatBuildRailLabel({ ...base, branch: "main" }))
  })

  it("fits the rail's width budget at the footer's 10px monospace", () => {
    // ~6.5px a glyph measured in the preview walk; the full-width row offers
    // ~200px after the button's padding. Guard the budget, not the pixels.
    expect(formatBuildRailLabel({ ...base, branch: "dev" }).length).toBeLessThanOrEqual(30)
  })

  it("omits the date rather than rendering a placeholder when it is unknown", () => {
    expect(formatBuildRailLabel({ ...base, branch: "dev", builtAt: "" })).toBe("v0.1.2 · abc1234")
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
