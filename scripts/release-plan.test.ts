import { describe, expect, it } from "vitest"
import { BATCH_SIZE, classifyFiles, planRelease } from "./release-plan.mjs"

const pr = (number: number, mergedAt: string, tier: "low" | "high" = "low") => ({
  number,
  sha: `sha${number}`,
  mergedAt,
  tier,
  areas: [],
})
const NOW = "2026-09-24T12:00:00Z"
const recent = "2026-09-24T10:00:00Z"

// One release in QA at a time keeps QA from re-testing a moving target and
// stops releases piling up; small batches keep each QA pass short.
describe("planRelease", () => {
  it("never cuts while another release is waiting for QA or deploy", () => {
    const prs = Array.from({ length: 10 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: ["release/2026/09/23"], prs, now: NOW })
    expect(plan.cut).toBe(false)
    expect(plan.reason).toContain("release/2026/09/23")
  })

  it("cuts as soon as a full batch is waiting", () => {
    const prs = Array.from({ length: BATCH_SIZE }, (_, i) => pr(i, recent))
    expect(planRelease({ openReleases: [], prs, now: NOW }).cut).toBe(true)
  })

  it("holds a small batch until the oldest PR has waited a day", () => {
    expect(planRelease({ openReleases: [], prs: [pr(1, recent)], now: NOW }).cut).toBe(false)
    expect(planRelease({ openReleases: [], prs: [pr(1, "2026-09-23T11:00:00Z")], now: NOW }).cut).toBe(true)
  })

  it("does not cut an empty release", () => {
    expect(planRelease({ openReleases: [], prs: [], now: NOW }).cut).toBe(false)
  })

  it("marks the release high risk if any PR is", () => {
    const plan = planRelease({ openReleases: [], prs: [pr(1, recent), pr(2, recent, "high")], now: NOW })
    expect(plan.tier).toBe("high")
  })
})

// High-risk releases need a human trigger; misclassifying one as low would skip it.
describe("classifyFiles", () => {
  it.each([
    ["db/postgres/migrations/0123_add.sql", "migration"],
    ["sync-worker/src/project-do.ts", "sync"],
    ["src/lib/sync/outbox.ts", "sync"],
    ["auth-worker/src/routes/orgs.ts", "auth"],
    ["sync-worker/wrangler.toml", "infra"],
    ["scripts/tag-release.sh", "infra"],
  ])("flags %s as %s", (file, area) => {
    expect(classifyFiles([file])).toEqual({ tier: "high", areas: [area] })
  })

  it("leaves UI and copy changes low risk", () => {
    expect(classifyFiles(["src/components/Editor.tsx", "src/locales/en.json", "docs/SEO.md"]).tier).toBe("low")
  })
})
