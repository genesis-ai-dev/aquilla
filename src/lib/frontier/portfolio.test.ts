import { describe, it, expect, vi, afterEach } from "vitest"
import { getPortfolio, validatedPct, attentionRank, type PortfolioProject } from "./portfolio"

const ORIG = global.fetch

afterEach(() => {
  global.fetch = ORIG
})

describe("getPortfolio", () => {
  it("GETs …/api/v2/orgs/1/portfolio and returns the projects array", async () => {
    const projects: PortfolioProject[] = [
      { id: "p1", name: "Alpha", totalCells: 100, validatedCells: 50, lastEditAt: Date.now() },
    ]
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
    const p: PortfolioProject = { id: "p", name: "P", totalCells: 200, validatedCells: 50, lastEditAt: null }
    expect(validatedPct(p)).toBe(0.25)
  })

  it("returns 0 when totalCells is 0", () => {
    const p: PortfolioProject = { id: "p", name: "P", totalCells: 0, validatedCells: 0, lastEditAt: null }
    expect(validatedPct(p)).toBe(0)
  })
})

describe("attentionRank", () => {
  it("a stalled fully-validated project ranks higher than a fresh half-validated project", () => {
    const now = Date.now()
    const stalledFullyValidated: PortfolioProject = {
      id: "s",
      name: "Stalled",
      totalCells: 100,
      validatedCells: 100, // fully validated
      lastEditAt: 0, // very old — well beyond 14 days
    }
    const freshHalfValidated: PortfolioProject = {
      id: "f",
      name: "Fresh",
      totalCells: 100,
      validatedCells: 50, // only 50% validated
      lastEditAt: now, // just edited
    }
    expect(attentionRank(stalledFullyValidated, now)).toBeGreaterThan(attentionRank(freshHalfValidated, now))
  })

  it("never-edited project (lastEditAt null) is treated as stale", () => {
    const now = Date.now()
    const neverEdited: PortfolioProject = {
      id: "n",
      name: "Never",
      totalCells: 100,
      validatedCells: 100,
      lastEditAt: null,
    }
    // rank should have the stale bonus (1000)
    expect(attentionRank(neverEdited, now)).toBeGreaterThanOrEqual(1000)
  })
})
