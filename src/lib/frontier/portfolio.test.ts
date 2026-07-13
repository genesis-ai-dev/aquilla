import { describe, it, expect, vi, afterEach } from "vitest"
import { getPortfolio, validatedPct, attentionRank, audioPct, audioValidatedPct, recordedMinutes, deadlineStatus, laneTranslatedPct, laneValidatedPct, type PortfolioProject, type PortfolioLane } from "./portfolio"

const ORIG = global.fetch

function project(over: Partial<PortfolioProject>): PortfolioProject {
  return { id: "p", name: "P", totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null, ...over }
}

afterEach(() => {
  global.fetch = ORIG
})

describe("getPortfolio", () => {
  it("GETs …/api/v2/orgs/1/portfolio and returns the projects array", async () => {
    const projects: PortfolioProject[] = [project({ id: "p1", name: "Alpha", totalCells: 100, validatedCells: 50, lastEditAt: Date.now(), audioCells: 25, recordedMs: 120000 })]
    let calledUrl = ""
    global.fetch = vi.fn(async (input: unknown) => {
      calledUrl = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ projects }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await getPortfolio("test-jwt", 1)
    expect(calledUrl).toMatch(/\/api\/v2\/orgs\/1\/portfolio$/)
    expect(result).toEqual(projects)
  })

  it("throws on non-OK status with a human message, not 'HTTP 403'", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    const err = await getPortfolio("jwt", 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/HTTP\s*403/)
    expect((err as Error).name).toBe("UserError")
  })
})

describe("validatedPct", () => {
  it("returns validated fraction when cells > 0", () => {
    expect(validatedPct(project({ totalCells: 200, validatedCells: 50 }))).toBe(0.25)
  })

  it("returns 0 when totalCells is 0", () => {
    expect(validatedPct(project({ totalCells: 0, validatedCells: 0 }))).toBe(0)
  })
})

describe("lane helpers (AQU-538)", () => {
  const lane = (over: Partial<PortfolioLane>): PortfolioLane => ({ lane: "", totalCells: 0, filledCells: 0, validatedCells: 0, lastEditAt: null, ...over })

  it("laneTranslatedPct is filled/total, 0 when empty", () => {
    expect(laneTranslatedPct(lane({ totalCells: 200, filledCells: 50 }))).toBe(0.25)
    expect(laneTranslatedPct(lane({ totalCells: 0, filledCells: 0 }))).toBe(0)
  })

  it("laneValidatedPct is validated/total, 0 when empty", () => {
    expect(laneValidatedPct(lane({ totalCells: 200, validatedCells: 20 }))).toBe(0.1)
    expect(laneValidatedPct(lane({ totalCells: 0, validatedCells: 0 }))).toBe(0)
  })

  it("getPortfolio round-trips the optional lanes[] array", async () => {
    const projects: PortfolioProject[] = [project({ id: "p1", lanes: [lane({ lane: "", totalCells: 100, filledCells: 40 }), lane({ lane: "es", totalCells: 100, filledCells: 10 })] })]
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ projects }), { status: 200 })) as unknown as typeof fetch
    const result = await getPortfolio("jwt", 1)
    expect(result[0].lanes).toHaveLength(2)
    expect(result[0].lanes?.[0].lane).toBe("")
  })
})

describe("audioPct", () => {
  it("returns audio fraction when cells > 0", () => {
    expect(audioPct(project({ totalCells: 200, audioCells: 50 }))).toBe(0.25)
  })

  it("returns 0 when totalCells is 0", () => {
    expect(audioPct(project({ totalCells: 0, audioCells: 0 }))).toBe(0)
  })
})

describe("audioValidatedPct (AQU-508)", () => {
  it("is validated audio over covered audio, not over total cells", () => {
    expect(audioValidatedPct(project({ totalCells: 200, audioCells: 50, validatedAudioCells: 20 }))).toBe(0.4)
  })

  it("returns 0 when no cells have audio (avoids divide-by-zero)", () => {
    expect(audioValidatedPct(project({ totalCells: 100, audioCells: 0, validatedAudioCells: 0 }))).toBe(0)
  })
})

describe("recordedMinutes", () => {
  it("rounds milliseconds to whole minutes", () => {
    expect(recordedMinutes(project({ recordedMs: 90000 }))).toBe(2) // 1.5 min → 2
    expect(recordedMinutes(project({ recordedMs: 120000 }))).toBe(2)
  })

  it("returns 0 for no recorded audio", () => {
    expect(recordedMinutes(project({ recordedMs: 0 }))).toBe(0)
  })
})

describe("deadlineStatus", () => {
  // "now" = 2026-06-01 noon UTC — a point in the middle of a calendar day
  const now = Date.parse("2026-06-01T12:00:00Z")

  it("returns null when there is no deadline", () => {
    expect(deadlineStatus(project({ deadlineAt: null }), now)).toBeNull()
  })

  it("flags a clearly past deadline as overdue", () => {
    expect(deadlineStatus(project({ deadlineAt: "2026-05-01" }), now)).toBe("overdue")
  })

  it("flags a deadline within 7 days as soon", () => {
    expect(deadlineStatus(project({ deadlineAt: "2026-06-04" }), now)).toBe("soon")
  })

  it("flags a far-future deadline as ok", () => {
    expect(deadlineStatus(project({ deadlineAt: "2026-09-01" }), now)).toBe("ok")
  })

  // AoE boundary tests (AQU-294): deadline is inclusive through end-of-day everywhere on earth.
  // UTC midnight of deadline + 36 h = end-of-day at UTC-12 (Baker/Howland Island).

  it("due TODAY is never overdue — even at UTC midnight of that day", () => {
    // now = 2026-06-01T00:00:00Z (UTC midnight of the deadline day itself)
    const atMidnight = Date.parse("2026-06-01T00:00:00Z")
    expect(deadlineStatus(project({ deadlineAt: "2026-06-01" }), atMidnight)).not.toBe("overdue")
  })

  it("due TODAY is never overdue — even late evening UTC on that day", () => {
    // now = 2026-06-01T23:59:59Z (one second before UTC midnight end of day)
    const lateEvening = Date.parse("2026-06-01T23:59:59Z")
    expect(deadlineStatus(project({ deadlineAt: "2026-06-01" }), lateEvening)).not.toBe("overdue")
  })

  it("due TODAY is never overdue — 35h59m after UTC midnight (still within AoE grace)", () => {
    // 35h59m after 2026-06-01T00:00:00Z = 2026-06-02T11:59:00Z — still within the 36h AoE grace
    const justBeforeGraceEnds = Date.parse("2026-06-01T00:00:00Z") + (36 * 60 * 60 * 1000 - 60 * 1000)
    expect(deadlineStatus(project({ deadlineAt: "2026-06-01" }), justBeforeGraceEnds)).not.toBe("overdue")
  })

  it("due YESTERDAY + AoE grace expired is overdue (exactly 36h after deadline UTC midnight)", () => {
    // Exactly 36h after 2026-06-01T00:00:00Z = 2026-06-02T12:00:00Z
    const graceExpired = Date.parse("2026-06-01T00:00:00Z") + 36 * 60 * 60 * 1000
    expect(deadlineStatus(project({ deadlineAt: "2026-06-01" }), graceExpired)).toBe("overdue")
  })
})

describe("attentionRank", () => {
  it("an overdue project out-ranks a merely-stalled one", () => {
    const now = Date.parse("2026-06-01T00:00:00Z")
    const overdue = project({ id: "o", totalCells: 100, validatedCells: 90, lastEditAt: now, deadlineAt: "2026-05-01" })
    const stalledOnly = project({ id: "s", totalCells: 100, validatedCells: 90, lastEditAt: 0 })
    expect(attentionRank(overdue, now)).toBeGreaterThan(attentionRank(stalledOnly, now))
  })

  it("a stalled fully-validated project ranks higher than a fresh half-validated project", () => {
    const now = Date.now()
    const stalledFullyValidated = project({ id: "s", name: "Stalled", totalCells: 100, validatedCells: 100, lastEditAt: 0 })
    const freshHalfValidated = project({ id: "f", name: "Fresh", totalCells: 100, validatedCells: 50, lastEditAt: now })
    expect(attentionRank(stalledFullyValidated, now)).toBeGreaterThan(attentionRank(freshHalfValidated, now))
  })

  it("never-edited project (lastEditAt null) is treated as stale", () => {
    const now = Date.now()
    const neverEdited = project({ id: "n", name: "Never", totalCells: 100, validatedCells: 100, lastEditAt: null })
    expect(attentionRank(neverEdited, now)).toBeGreaterThanOrEqual(1000)
  })
})
