import { describe, expect, it } from "vitest"
import { portfolioAttentionReasons } from "@/lib/project-status"
import {
  audioPct,
  deadlineStatus,
  portfolioActivityStatus,
  portfolioCountsByLanguage,
  portfolioDeliversText,
  portfolioMeasure,
  progressPct,
  startedPct,
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

  // AQU-1566: a dubbing project records against its cue sheet, so the All Orgs
  // total divides its takes by the sheet's cell count, the same as OrgHome.
  it("measures a dubbing project's audio against its cue sheet", () => {
    const dubbed = project({ totalCells: 646, filledCells: 0, audioTotalCells: 548, audioCells: 274 })
    expect(audioPct(dubbed)).toBe(0.5)
    expect(summarizePortfolioProjects([dubbed], NOW).avgAudioPct).toBe(0.5)
    // An older server sends no audio total: the text total, as before.
    expect(audioPct(project({ totalCells: 100, filledCells: 0, audioCells: 25 }))).toBe(0.25)
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

// Media redesign slice 1: each language counts by what it delivers. A project
// whose languages all deliver Text (or have not chosen) reads its project-wide
// figures exactly as before; with an Audio or a Text and audio language the
// project is measured language by language (gap 5).
describe("measuring a project by what its languages deliver", () => {
  const lane = (over: Record<string, unknown>) => ({
    role: "target" as const,
    lastEditAt: NOW,
    totalCells: 45,
    filledCells: 0,
    validatedCells: 0,
    audioTotalCells: 45,
    audioCells: 0,
    validatedAudioCells: 0,
    bothValidatedCells: 0,
    ...over,
  })

  it("leaves a Text project, and one nobody has chosen for, exactly as it was", () => {
    for (const delivers of ["text", null, undefined]) {
      const p = project({
        totalCells: 100, filledCells: 60, validatedCells: 30, audioCells: 40,
        lanes: [lane({ delivers, totalCells: 999, filledCells: 1, validatedCells: 1, audioCells: 40 })],
      })
      expect(portfolioCountsByLanguage(p)).toBe(false)
      expect(portfolioMeasure(p)).toEqual({ total: 100, started: 60, done: 30, headline: 60 })
      expect(translatedPct(p)).toBe(0.6)
      expect(validatedPct(p)).toBe(0.3)
      expect(progressPct(p)).toBe(0.6)
      expect(startedPct(p)).toBe(0.6)
      expect(portfolioDeliversText(p)).toBe(true)
    }
  })

  it("measures an Audio project by its recordings: 45 lines, 17 recorded, 9 approved (P1.4)", () => {
    const p = project({
      totalCells: 45, filledCells: 0, audioCells: 17,
      lanes: [{ role: "source" as const, lastEditAt: null }, lane({ delivers: "audio", audioCells: 17, validatedAudioCells: 9 })],
    })
    expect(portfolioMeasure(p)).toEqual({ total: 45, started: 17, done: 9, headline: 9 })
    expect(validatedPct(p)).toBe(9 / 45)
    expect(progressPct(p)).toBe(9 / 45)
    expect(startedPct(p)).toBe(17 / 45)
    expect(portfolioDeliversText(p)).toBe(false)
    expect(translatedPct(p)).toBe(0)
  })

  it("reads an Audio project as started from its first recording, and Stalled only when it goes quiet (P1.5)", () => {
    const recorded = project({
      totalCells: 22, filledCells: 0, lastEditAt: NOW - 20 * DAY,
      lanes: [lane({ delivers: "audio", audioCells: 2, lastEditAt: NOW - DAY })],
    })
    expect(portfolioActivityStatus(recorded, NOW)).toBe("active")
    const quiet = project({
      totalCells: 22, filledCells: 0, lastEditAt: NOW - 20 * DAY,
      lanes: [lane({ delivers: "audio", audioCells: 2, lastEditAt: NOW - 20 * DAY })],
    })
    expect(portfolioActivityStatus(quiet, NOW)).toBe("stalled")
    const untouched = project({ totalCells: 22, filledCells: 0, lanes: [lane({ delivers: "audio" })] })
    expect(portfolioActivityStatus(untouched, NOW)).toBe("not-started")
  })

  it("counts a Text and audio line done only on both halves (P1.6)", () => {
    const p = project({
      totalCells: 10, filledCells: 9, validatedCells: 7,
      lanes: [lane({
        delivers: "text_and_audio", totalCells: 10, filledCells: 9, validatedCells: 7,
        audioTotalCells: 10, audioCells: 6, validatedAudioCells: 6, bothValidatedCells: 4,
      })],
    })
    expect(portfolioMeasure(p)).toEqual({ total: 10, started: 9, done: 4, headline: 4 })
    expect(validatedPct(p)).toBe(0.4)
    expect(portfolioDeliversText(p)).toBe(true)
  })

  it("sums each language's done lines over all their lines, and translated over the text ones (gap 5)", () => {
    const p = project({
      totalCells: 90, filledCells: 22, validatedCells: 11,
      lanes: [
        lane({ delivers: "text", filledCells: 22, validatedCells: 11 }),
        lane({ delivers: "audio", audioCells: 30, validatedAudioCells: 22 }),
      ],
    })
    expect(portfolioMeasure(p)).toEqual({ total: 90, started: 52, done: 33, headline: 44 })
    expect(translatedPct(p)).toBe(22 / 45)
  })

  it("keeps an audio-only project out of the translated mean, not at 0", () => {
    const text = project({ totalCells: 10, filledCells: 5 })
    const audio = project({ totalCells: 45, filledCells: 0, lanes: [lane({ delivers: "audio", audioCells: 45, validatedAudioCells: 45 })] })
    const summary = summarizePortfolioProjects([text, audio], NOW)
    expect(summary.avgTranslatedPct).toBe(0.5)
    expect(summary.avgValidatedPct).toBe(0.5)
  })
})
