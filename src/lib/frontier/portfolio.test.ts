import { describe, it, expect, vi, afterEach } from "vitest"
import { getPortfolio, validatedPct, attentionRank, audioPct, recordedMinutes, deadlineStatus, type PortfolioProject } from "./portfolio"

const ORIG = global.fetch

function project(over: Partial<PortfolioProject>): PortfolioProject {
  return { id: "p", name: "P", totalCells: 0, validatedCells: 0, lastEditAt: null, audioCells: 0, recordedMs: 0, deadlineAt: null, ...over }
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

  it("throws on non-OK status", async () => {
    global.fetch = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch
    await expect(getPortfolio("jwt", 1)).rejects.toThrow(/HTTP 403/)
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

describe("audioPct", () => {
  it("returns audio fraction when cells > 0", () => {
    expect(audioPct(project({ totalCells: 200, audioCells: 50 }))).toBe(0.25)
  })

  it("returns 0 when totalCells is 0", () => {
    expect(audioPct(project({ totalCells: 0, audioCells: 0 }))).toBe(0)
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
  const now = Date.parse("2026-06-01T00:00:00Z")
  it("returns null when there is no deadline", () => {
    expect(deadlineStatus(project({ deadlineAt: null }), now)).toBeNull()
  })
  it("flags a past deadline as overdue", () => {
    expect(deadlineStatus(project({ deadlineAt: "2026-05-01" }), now)).toBe("overdue")
  })
  it("flags a deadline within 7 days as soon", () => {
    expect(deadlineStatus(project({ deadlineAt: "2026-06-04" }), now)).toBe("soon")
  })
  it("flags a far-future deadline as ok", () => {
    expect(deadlineStatus(project({ deadlineAt: "2026-09-01" }), now)).toBe("ok")
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
