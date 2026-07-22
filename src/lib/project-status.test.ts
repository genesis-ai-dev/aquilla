import { describe, it, expect } from "vitest"
import type { PortfolioProject } from "@/lib/frontier/portfolio"
import { portfolioActivityStatus } from "@/lib/project-status"

const DAY = 24 * 60 * 60 * 1000

const base: PortfolioProject = {
  id: "p",
  name: "P",
  totalCells: 100,
  validatedCells: 0,
  filledCells: 0,
  aiDraftedCells: 0,
  lastEditAt: null,
  audioCells: 0,
  validatedAudioCells: 0,
  recordedMs: 0,
  deadlineAt: null,
  sourceLanguage: null,
  targetLanguage: null,
}

describe("portfolioActivityStatus", () => {
  const now = Date.now()

  it("never-translated project is not-started when lastEditAt is null", () => {
    expect(portfolioActivityStatus({ ...base, filledCells: 0, lastEditAt: null }, now)).toBe(
      "not-started",
    )
  })

  // AQU-639 regression guard: importing source text stamps files.last_edit_at,
  // so an imported-but-untranslated project carries a non-null (and eventually
  // stale) lastEditAt. It must still read as "not-started", not "Stalled" — the
  // presence of a source-import timestamp is not translation activity.
  it("imported-but-untranslated project is not-started even with a stale lastEditAt", () => {
    const staleImport = now - 30 * DAY
    expect(
      portfolioActivityStatus({ ...base, filledCells: 0, lastEditAt: staleImport }, now),
    ).toBe("not-started")
  })

  it("translated project gone quiet 14+ days is stalled", () => {
    expect(
      portfolioActivityStatus({ ...base, filledCells: 50, lastEditAt: now - 30 * DAY }, now),
    ).toBe("stalled")
  })

  it("translated work with no timestamp is stalled, not not-started", () => {
    expect(portfolioActivityStatus({ ...base, filledCells: 10, lastEditAt: null }, now)).toBe(
      "stalled",
    )
  })

  it("recently edited translated project is active", () => {
    expect(portfolioActivityStatus({ ...base, filledCells: 5, lastEditAt: now }, now)).toBe(
      "active",
    )
  })

  it("a translated project edited within the last 14 days is active, not stalled", () => {
    expect(
      portfolioActivityStatus({ ...base, filledCells: 5, lastEditAt: now - 3 * DAY }, now),
    ).toBe("active")
  })
})
