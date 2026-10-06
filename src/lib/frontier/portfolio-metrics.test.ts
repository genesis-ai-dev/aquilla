import { describe, expect, it } from "vitest"
import { portfolioAttentionReasons } from "@/lib/project-status"
import {
  audioPct,
  deadlineStatus,
  portfolioActivityStatus,
  projectNeedsPortfolioAttention,
  summarizePortfolioProjects,
  translatedPct,
  validatedPct,
  type PortfolioMetricsProject,
} from "./portfolio-metrics"

const NOW = Date.parse("2026-06-15T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000

function project(over: Partial<PortfolioMetricsProject> & Pick<PortfolioMetricsProject, "totalCells" | "filledCells">): PortfolioMetricsProject {
  return {
    validatedCells: 0,
    lastEditAt: NOW,
    audioCells: 0,
    deadlineAt: null,
    ...over,
  }
}

/**
 * The All Orgs overview used to reduce the unpaged portfolio on the client.
 * These expressions are that reduction. The server summary has to match them,
 * including a zero-cell project in the denominator and lane activity for Stalled.
 */
function clientRollup(projects: PortfolioMetricsProject[], now: number) {
  const n = projects.length
  return {
    projectCount: n,
    avgTranslatedPct: n > 0 ? projects.reduce((sum, p) => sum + translatedPct(p), 0) / n : 0,
    avgValidatedPct: n > 0 ? projects.reduce((sum, p) => sum + validatedPct(p), 0) / n : 0,
    avgAudioPct: n > 0 ? projects.reduce((sum, p) => sum + audioPct(p), 0) / n : 0,
    stalledCount: projects.filter((p) => portfolioActivityStatus(p, now) === "stalled").length,
    overdueCount: projects.filter((p) => deadlineStatus(p, now) === "overdue").length,
    attentionCount: projects.filter((p) => portfolioAttentionReasons(p, now).length > 0).length,
  }
}

describe("summarizePortfolioProjects", () => {
  const projects = [
    project({ totalCells: 1, filledCells: 1, validatedCells: 1 }),
    project({ totalCells: 100, filledCells: 0, validatedCells: 0, lastEditAt: NOW - 30 * DAY }),
    project({
      totalCells: 100,
      filledCells: 50,
      validatedCells: 25,
      audioCells: 200,
      lastEditAt: NOW - 30 * DAY,
      lanes: [{ lastEditAt: NOW }],
    }),
    project({
      totalCells: 10,
      filledCells: 10,
      validatedCells: 0,
      lastEditAt: NOW - 30 * DAY,
      deadlineAt: "2020-01-01",
    }),
    project({ totalCells: 10, filledCells: 10, validatedCells: 10, deadlineAt: "2026-06-17" }),
    project({
      totalCells: 10,
      filledCells: 10,
      validatedCells: 10,
      deadlineAt: "2027-01-01",
      unitsOverdue: 2,
    }),
  ]

  it("matches the client overview reduction, including lane activity and zero-cell projects", () => {
    const summary = summarizePortfolioProjects(projects, NOW)
    expect(summary).toEqual(clientRollup(projects, NOW))
    // Unweighted: 100% and 0% of 100 cells average to 50%, not ~1%.
    expect(summary.avgTranslatedPct).toBeCloseTo(4.5 / 6)
    expect(summary.avgValidatedPct).toBeCloseTo(3.25 / 6)
    // Audio above the text total clamps to 100% before the mean.
    expect(summary.avgAudioPct).toBeCloseTo(1 / 6)
    expect(summary.stalledCount).toBe(1)
    expect(summary.overdueCount).toBe(1)
    // Stalled/overdue, due soon, and behind-plan. The lane-fresh project is not stalled.
    expect(summary.attentionCount).toBe(3)
  })

  it("counts attention exactly when portfolioAttentionReasons is non-empty", () => {
    for (const row of projects) {
      expect(projectNeedsPortfolioAttention(row, NOW)).toBe(portfolioAttentionReasons(row, NOW).length > 0)
    }
  })

  it("returns zeros for an empty portfolio", () => {
    expect(summarizePortfolioProjects([], NOW)).toEqual({
      projectCount: 0,
      avgTranslatedPct: 0,
      avgValidatedPct: 0,
      avgAudioPct: 0,
      stalledCount: 0,
      overdueCount: 0,
      attentionCount: 0,
    })
  })
})
