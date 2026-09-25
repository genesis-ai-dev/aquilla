import { describe, expect, it } from "vitest"
import { classifyFiles, isDocsOrTestOnly, planRelease, prHolds } from "./release-plan.mjs"

const pr = (
  number: number,
  mergedAt: string,
  { areas = [] as string[], pathHolds = false, walk = "PASS" as string } = {},
) => ({ number, sha: `sha${number}`, mergedAt, areas, pathHolds, walk })

const migration = (number: number, mergedAt: string) => pr(number, mergedAt, { areas: ["migration"], pathHolds: true })
const syncPr = (number: number, mergedAt: string) => pr(number, mergedAt, { areas: ["sync"] })
const authPr = (number: number, mergedAt: string) => pr(number, mergedAt, { areas: ["auth"] })

const NOW = "2026-09-24T12:00:00Z"
const recent = "2026-09-24T10:00:00Z"

// One release in QA at a time keeps QA from re-testing a moving target. The
// next slice cuts the instant that one closes, at whatever's ready in dev —
// no ceiling, no wait timer — so a hotfix cherry-picked onto the closed
// branch is already on dev by the time the next slice is cut.
describe("planRelease", () => {
  it("never cuts while another release is waiting for QA or deploy", () => {
    const prs = Array.from({ length: 10 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: ["release/2026/09/23-01"], prs, now: NOW })
    expect(plan.cut).toBe(false)
    expect(plan.reason).toContain("release/2026/09/23-01")
  })

  it("cuts every ready PR the instant the line is free, naming the branch and sha", () => {
    const prs = Array.from({ length: 3 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(false)
    expect(plan.prs).toHaveLength(3)
    expect(plan.sha).toBe(prs[2].sha)
    expect(plan.branch).toBe("release/2026/09/24-01")
  })

  it("cuts a single ready PR immediately, with no wait", () => {
    const plan = planRelease({ openReleases: [], prs: [pr(1, recent)], now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(false)
    expect(plan.prs).toHaveLength(1)
  })

  it("has no ceiling: a large ready run cuts as one slice", () => {
    const prs = Array.from({ length: 200 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(false)
    expect(plan.prs).toHaveLength(200)
  })

  it("the next free suffix skips branches already cut today", () => {
    const prs = Array.from({ length: 3 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: [], prs, now: NOW, usedSuffixesToday: ["01", "02"] })
    expect(plan.branch).toBe("release/2026/09/24-03")
  })

  it("does not cut an empty release", () => {
    expect(planRelease({ openReleases: [], prs: [], now: NOW }).cut).toBe(false)
  })

  it("cuts the oldest migration PR alone and immediately, even with plenty waiting behind it", () => {
    const prs = [migration(1, "2026-09-23T09:00:00Z"), ...Array.from({ length: 6 }, (_, i) => pr(i + 2, recent))]
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(true)
    expect(plan.prs).toHaveLength(1)
    expect(plan.prs[0].number).toBe(1)
    expect(plan.areas).toEqual(["migration"])
  })

  it("ships the ready run the moment a holding PR sits behind it", () => {
    const prs = [pr(1, recent), pr(2, recent), migration(3, recent), pr(4, recent)]
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(false)
    expect(plan.prs.map((p: { number: number }) => p.number)).toEqual([1, 2])
  })

  it("holds on a FAIL or unknown walk the same way a path hold does", () => {
    const failed = planRelease({ openReleases: [], prs: [pr(1, recent, { walk: "fail" })], now: NOW })
    expect(failed.cut).toBe(true)
    expect(failed.hold).toBe(true)

    const unknown = planRelease({ openReleases: [], prs: [pr(1, recent, { walk: "unknown" })], now: NOW })
    expect(unknown.cut).toBe(true)
    expect(unknown.hold).toBe(true)
  })

  it("does not hold on sync or auth alone, but still notes the areas", () => {
    const prs = Array.from({ length: 6 }, (_, i) => (i % 2 ? syncPr(i, recent) : authPr(i, recent)))
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(false)
    expect(plan.areas).toEqual(["auth", "sync"])
  })
})

describe("prHolds", () => {
  it("holds on a path match regardless of walk", () => {
    expect(prHolds({ pathHolds: true, walk: "PASS" })).toBe(true)
  })

  it("does not hold on a clean walk with no path match", () => {
    expect(prHolds({ pathHolds: false, walk: "PASS" })).toBe(false)
    expect(prHolds({ pathHolds: false, walk: "none" })).toBe(false)
  })
})

// A docs- or test-only PR has no UI claim, so the bot never posts a walk
// comment for it — the planner has to know that on sight, from paths alone,
// rather than waiting forever on a lookup that will never resolve.
describe("isDocsOrTestOnly", () => {
  it("is true for docs and test/journey files only", () => {
    expect(isDocsOrTestOnly(["docs/SEO.md", "README.md"])).toBe(true)
    expect(isDocsOrTestOnly(["src/lib/foo.test.ts", "e2e/journeys/PR-BOT.md"])).toBe(true)
  })

  it("is false once any file has a UI claim", () => {
    expect(isDocsOrTestOnly(["docs/SEO.md", "src/components/Editor.tsx"])).toBe(false)
  })

  it("is false for an empty diff", () => {
    expect(isDocsOrTestOnly([])).toBe(false)
  })
})

// A misclassified migration or deploy-infra change would skip the one gate
// that keeps a schema change or a deploy-script change off the ordinary line.
describe("classifyFiles", () => {
  it.each([
    ["db/postgres/migrations/0123_add.sql", "migration", true],
    ["db/postgres/schema.sql", "migration", true],
    ["wrangler.toml", "infra", true],
    ["config/cloudflare-deployments.json", "infra", true],
    ["scripts/tag-release.sh", "infra", true],
    ["scripts/verify-deploy-branch.sh", "infra", true],
    ["scripts/resolve-deployment-target.sh", "infra", true],
    ["sync-worker/src/project-do.ts", "sync", false],
    ["src/lib/sync/outbox.ts", "sync", false],
    ["db/shim/postgres.ts", "sync", false],
    ["auth-worker/src/routes/orgs.ts", "auth", false],
  ])("flags %s as %s, holding: %s", (file, area, pathHolds) => {
    expect(classifyFiles([file])).toEqual({ areas: [area], pathHolds })
  })

  it("leaves UI and copy changes with no area and no hold", () => {
    expect(classifyFiles(["src/components/Editor.tsx", "src/locales/en.json", "docs/SEO.md"]))
      .toEqual({ areas: [], pathHolds: false })
  })
})

// Built from the shape of 2026-09-23's real queue (29 PRs, 14 touching sync
// or auth, 4 of those auth-worker alone, none holding on their own): with no
// ceiling, a busy day this size cuts as one slice the instant the line is
// free, rather than four full slices plus a short one.
describe("a 29-PR day shaped like 2026-09-23", () => {
  function fixture() {
    const prs = []
    for (let i = 1; i <= 29; i++) {
      const mergedAt = `2026-09-23T${String(8 + Math.floor(i / 3)).padStart(2, "0")}:00:00Z`
      if (i <= 10) prs.push(syncPr(i, mergedAt))
      else if (i <= 14) prs.push(authPr(i, mergedAt))
      else prs.push(pr(i, mergedAt))
    }
    return prs
  }

  it("ships all 29 as one slice, none of them holding", () => {
    const plan = planRelease({ openReleases: [], prs: fixture(), now: "2026-09-24T00:00:00Z" })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(false)
    expect(plan.prs).toHaveLength(29)
  })
})
