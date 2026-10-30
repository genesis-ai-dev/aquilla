import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  classifyFiles,
  holdReason,
  isDocsOrTestOnly,
  planRelease,
  prHolds,
  prNumberFromSubject,
  releasedMarks,
  splitReleased,
  unreleasedPrs,
} from "./release-plan.mjs"

const pr = (
  number: number,
  mergedAt: string,
  { areas = [] as string[], pathHolds = false, walk = "PASS" as string } = {},
) => ({ number, sha: `sha${number}`, mergedAt, areas, pathHolds, walk })

const migration = (number: number, mergedAt: string) => pr(number, mergedAt, { areas: ["migration"], pathHolds: true })
const syncPr = (number: number, mergedAt: string) => pr(number, mergedAt, { areas: ["sync"] })
const authPr = (number: number, mergedAt: string) => pr(number, mergedAt, { areas: ["auth"], pathHolds: true })
const exportPr = (number: number, mergedAt: string) => pr(number, mergedAt, { areas: ["export"] })

const NOW = "2026-09-24T12:00:00Z"
const recent = "2026-09-24T10:00:00Z"

// One release in QA at a time keeps QA from re-testing a moving target. The
// next slice cuts the instant that one closes, at whatever's ready in dev.
// Ready PRs are picked around held ones (the cherry-pick model), so a held
// schema change never walls off the PRs merged after it.
describe("planRelease", () => {
  it("never cuts while another release is waiting for QA or deploy", () => {
    const prs = Array.from({ length: 10 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: ["release/2026/09/23-01"], prs, now: NOW })
    expect(plan.cut).toBe(false)
    expect(plan.reason).toContain("release/2026/09/23-01")
  })

  it("cuts every ready PR the instant the line is free, naming the branch and base", () => {
    const prs = Array.from({ length: 3 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: [], prs, now: NOW, base: "tagtip" })
    expect(plan.cut).toBe(true)
    expect(plan.prs).toHaveLength(3)
    expect(plan.held).toEqual([])
    expect(plan.base).toBe("tagtip")
    expect(plan.branch).toBe("release/2026/09/24-01")
  })

  it("has no ceiling: a large ready run cuts as one slice", () => {
    const prs = Array.from({ length: 200 }, (_, i) => pr(i, recent))
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
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

  it("picks around a held migration: the PRs behind it still ship, the migration waits", () => {
    const prs = [migration(1, "2026-09-23T09:00:00Z"), ...Array.from({ length: 6 }, (_, i) => pr(i + 2, recent))]
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.prs.map((p) => p.number)).toEqual([2, 3, 4, 5, 6, 7])
    expect(plan.held).toEqual([expect.objectContaining({ number: 1, why: "touches migration" })])
    expect(plan.areas).toEqual([])
  })

  it("picks around a held PR in the middle of the queue too", () => {
    const prs = [pr(1, recent), pr(2, recent), migration(3, recent), pr(4, recent)]
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.prs.map((p) => p.number)).toEqual([1, 2, 4])
    expect(plan.held.map((p) => p.number)).toEqual([3])
  })

  it("does not cut when every unreleased PR is held", () => {
    const plan = planRelease({ openReleases: [], prs: [migration(1, recent), pr(2, recent, { walk: "fail" })], now: NOW })
    expect(plan.cut).toBe(false)
    expect(plan.reason).toBe("2 PR(s) waiting on a person, none ready")
    expect(plan.held.map((p) => p.why)).toEqual(["touches migration", "walk fail"])
  })

  it("holds on a FAIL or unknown walk the same way a path hold does", () => {
    const failed = planRelease({ openReleases: [], prs: [pr(1, recent, { walk: "fail" }), pr(2, recent)], now: NOW })
    expect(failed.prs.map((p) => p.number)).toEqual([2])
    expect(failed.held.map((p) => p.number)).toEqual([1])

    const unknown = planRelease({ openReleases: [], prs: [pr(1, recent, { walk: "unknown" }), pr(2, recent)], now: NOW })
    expect(unknown.held.map((p) => p.number)).toEqual([1])
  })

  it("a person's release:approved label puts a held PR back on the line", () => {
    const prs = [{ ...migration(1, recent), approved: true }, { ...pr(2, recent, { walk: "fail" }), approved: true }]
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.prs.map((p) => p.number)).toEqual([1, 2])
    expect(plan.held).toEqual([])
    expect(plan.areas).toEqual(["migration"])
  })

  it("does not hold on export or sync alone, but still notes the areas", () => {
    const prs = Array.from({ length: 6 }, (_, i) => (i % 2 ? syncPr(i, recent) : exportPr(i, recent)))
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.cut).toBe(true)
    expect(plan.held).toEqual([])
    expect(plan.areas).toEqual(["export", "sync"])
  })

  it("does not leak pathHolds or behindFloor into the reported PRs", () => {
    const plan = planRelease({ openReleases: [], prs: [{ ...pr(1, recent), behindFloor: true }, migration(2, recent)], now: NOW })
    expect(plan.prs[0]).not.toHaveProperty("behindFloor")
    expect(plan.prs[0]).not.toHaveProperty("pathHolds")
    expect(plan.held[0]).not.toHaveProperty("pathHolds")
  })
})

describe("prHolds", () => {
  it("holds on a holding area regardless of walk", () => {
    expect(prHolds({ areas: ["auth"], walk: "PASS" })).toBe(true)
  })

  it("does not hold on a clean walk with only noted areas", () => {
    expect(prHolds({ areas: ["export", "sync"], walk: "PASS" })).toBe(false)
    expect(prHolds({ areas: [], walk: "none" })).toBe(false)
  })

  it("never holds an approved PR: the label is the manual path's sign-off", () => {
    expect(prHolds({ areas: ["auth"], walk: "fail", approved: true })).toBe(false)
  })

  // The point of a gate: an events PR whose replay-gate check passed is
  // low-risk by test, not by a person, and rides the hourly line.
  it("does not hold an events PR whose replay gate passed, but still holds its other areas", () => {
    expect(prHolds({ areas: ["events"], walk: "PASS", gates: ["events"] })).toBe(false)
    expect(prHolds({ areas: ["events", "migration"], walk: "PASS", gates: ["events"] })).toBe(true)
    expect(holdReason({ areas: ["events", "migration"], walk: "PASS", gates: ["events"] })).toBe("touches migration")
  })

  it("a passed gate does not excuse a failed walk", () => {
    expect(prHolds({ areas: ["events"], walk: "fail", gates: ["events"] })).toBe(true)
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

  it("is true for an allowlisted scripts-only diff", () => {
    expect(isDocsOrTestOnly(["scripts/release-plan.mjs", "scripts/release-plan.d.mts"])).toBe(true)
    expect(isDocsOrTestOnly(["scripts/qa/agent-evidence.mts", "scripts/smart-tests.ts", "scripts/e2e-up.ts"])).toBe(true)
  })

  // vite.config.ts imports these, so a change to them ships in the app.
  it.each(["scripts/vite-html-branding.ts", "scripts/build-info.ts"])("is false for %s, which the app build imports", (file) => {
    expect(isDocsOrTestOnly([file])).toBe(false)
  })

  it("is false for a script not on the allowlist", () => {
    expect(isDocsOrTestOnly(["scripts/brand-new-tool.ts"])).toBe(false)
  })

  it("is false once a scripts file mixes in with app code", () => {
    expect(isDocsOrTestOnly(["scripts/release-plan.mjs", "src/components/Editor.tsx"])).toBe(false)
  })
})

// An infra-area script (tag-release, verify-*, resolve-deployment,
// cloudflare-*) is off the no-UI allowlist, and it must hold on its own via
// pathHolds even if a walk says PASS.
describe("scripts-only PR that is also infra", () => {
  it("holds on the infra path whatever the walk says", () => {
    const files = ["scripts/tag-release.sh"]
    expect(isDocsOrTestOnly(files)).toBe(false)
    const { areas, pathHolds } = classifyFiles(files)
    expect(pathHolds).toBe(true)
    expect(prHolds({ areas, walk: "PASS" })).toBe(true)
  })
})

// The file map itself is tested in release-risk.test.ts; this pins that the
// planner reads the same table.
describe("classifyFiles", () => {
  it("is release-risk.mjs's classification", () => {
    expect(classifyFiles(["db/postgres/schema.sql"])).toEqual({ areas: ["migration", "events"], pathHolds: true })
    expect(classifyFiles(["src/components/Editor.tsx"])).toEqual({ areas: [], pathHolds: false })
  })
})

// Built from the shape of 2026-09-23's real queue (29 PRs, 14 touching sync
// or auth, 4 of those auth-worker alone): with no ceiling, a busy day this
// size cuts as one slice the instant the line is free. Under the cherry-pick
// model the 4 auth PRs wait for a person and the other 25 still ship.
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

  it("ships the 25 ready PRs as one slice and holds the 4 auth PRs", () => {
    const plan = planRelease({ openReleases: [], prs: fixture(), now: "2026-09-24T00:00:00Z" })
    expect(plan.cut).toBe(true)
    expect(plan.prs).toHaveLength(25)
    expect(plan.held.map((p) => p.number)).toEqual([11, 12, 13, 14])
  })
})

// A release branch is built by `git cherry-pick -x -m 1 <dev merge sha>`
// (docs/DEPLOYMENT-ENVIRONMENTS.md "Cutting a release"), so the calver tag
// sits on a pick off dev's first-parent line and `<tag>..origin/dev` never
// shrinks. release/2026/09/29-01 and 30-01 were both cut from dev merges
// (#769, #751) that production tag 2026.09.29.01 already carried: every PR
// since the last on-dev tag looked unreleased, and "oldest holds, cut it
// alone" produced one stale single-PR slice per run. These pin the fix: a
// dev PR is released once the tagged tip carries its pick (by provenance in
// the body, or by the same "Merge pull request #N" subject), and no slice
// cuts below the newest dev commit production already runs.
const devSha = (n: number) => `d${n}`.padEnd(40, "0")
const pickSha = (n: number) => `c${n}`.padEnd(40, "0")
const devMerge = (n: number) => ({ sha: devSha(n), subject: `Merge pull request #${n} from genesis-ai-dev/agent/AQU-${n}` })
const pickOf = (n: number, { x = true } = {}) => ({
  sha: pickSha(n),
  subject: `Merge pull request #${n} from genesis-ai-dev/agent/AQU-${n}`,
  body: x ? `AQU-${n} title\n\n(cherry picked from commit ${devSha(n)})\n` : `AQU-${n} title\n`,
})

describe("prNumberFromSubject", () => {
  it("reads GitHub merge and squash subjects", () => {
    expect(prNumberFromSubject("Merge pull request #912 from genesis-ai-dev/hotfix/agent-connect-handoff")).toBe(912)
    expect(prNumberFromSubject("fix: stop on ruleset rejections (#908)")).toBe(908)
  })

  it("is undefined for anything else", () => {
    expect(prNumberFromSubject("Merge branch 'dev' into release/2026/09/28-03")).toBeUndefined()
    expect(prNumberFromSubject("chore: bump")).toBeUndefined()
  })
})

describe("releasedMarks", () => {
  it("reads pick provenance out of the body, where -x puts it (it is not a trailer)", () => {
    const marks = releasedMarks([pickOf(781)])
    expect(marks.shas).toEqual(new Set([devSha(781)]))
    expect(marks.numbers).toEqual(new Set([781]))
  })

  it("still keys a pick made without -x by its PR number", () => {
    const marks = releasedMarks([pickOf(956, { x: false })])
    expect(marks.shas.size).toBe(0)
    expect(marks.numbers).toEqual(new Set([956]))
  })

  it("ignores commits that are neither", () => {
    const marks = releasedMarks([{ subject: "chore: bump version", body: "" }])
    expect(marks.shas.size + marks.numbers.size).toBe(0)
  })
})

describe("splitReleased", () => {
  it("tag directly on dev: nothing is off dev, so every PR above the cut point waits", () => {
    const cutPoint = devSha(769)
    const { unreleased, floor } = splitReleased({ devEntries: [devMerge(770), devMerge(771)], marks: releasedMarks([]), cutPoint })
    expect(unreleased.map((e) => e.sha)).toEqual([devSha(770), devSha(771)])
    expect(unreleased.every((e) => !e.behindFloor)).toBe(true)
    expect(floor).toBe(cutPoint)
  })

  it("tag on a cherry-pick tip: picked dev merges are released and the floor is the newest of them", () => {
    const devEntries = [devMerge(772), devMerge(774), devMerge(781), devMerge(900), devMerge(901)]
    const marks = releasedMarks([pickOf(772), pickOf(774), pickOf(781)])
    const { unreleased, floor } = splitReleased({ devEntries, marks, cutPoint: devSha(769) })
    expect(unreleased.map((e) => e.sha)).toEqual([devSha(900), devSha(901)])
    expect(unreleased.every((e) => !e.behindFloor)).toBe(true)
    expect(floor).toBe(devSha(781))
  })

  // 2026.09.28.03's shape: a cut at #724 plus picks of #910 (without -x) and
  // #912, while the dev merges between them, #776's migration among them,
  // were never picked. They stay in the plan, behind the floor.
  it("mixed: a hotfix picked ahead of its dev order leaves the older PRs waiting behind the floor", () => {
    const devEntries = [devMerge(900), devMerge(776), devMerge(910), devMerge(911), devMerge(912), devMerge(920)]
    const marks = releasedMarks([pickOf(910, { x: false }), pickOf(912)])
    const { unreleased, floor } = splitReleased({ devEntries, marks, cutPoint: devSha(724) })
    expect(unreleased.map((e) => [e.sha, e.behindFloor])).toEqual([
      [devSha(900), true],
      [devSha(776), true],
      [devSha(911), true],
      [devSha(920), false],
    ])
    expect(floor).toBe(devSha(912))
  })
})

// The bug lived in the git plumbing, not the pure rules: the range was
// `<tag>..origin/dev`. This builds each tag shape in a scratch repo and runs
// the real command against it.
describe("unreleasedPrs against a scratch repo", () => {
  let root: string
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim()

  // A dev merge of PR #number touching one file, GitHub's merge subject and
  // all, with origin/dev advanced to it.
  const mergePr = (number: number, file: string) => {
    git("checkout", "-q", "-b", `pr-${number}`, "dev")
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), `${number}\n`)
    git("add", "-A")
    git("commit", "-qm", `AQU-${number}: change`)
    git("checkout", "-q", "dev")
    git("merge", "-q", "--no-ff", "-m", `Merge pull request #${number} from genesis-ai-dev/agent/AQU-${number}`, `pr-${number}`)
    git("update-ref", "refs/remotes/origin/dev", "dev")
    return git("rev-parse", "HEAD")
  }
  // A release branch cut at `at`, built the documented way, then tagged.
  const release = (at: string, picks: { sha: string; x?: boolean }[], tag: string) => {
    git("checkout", "-q", "-b", `release/${tag.slice(0, 10).replaceAll(".", "/")}-01`, at)
    for (const { sha, x = true } of picks) git("cherry-pick", ...(x ? ["-x"] : []), "-m", "1", sha)
    git("tag", tag)
    git("checkout", "-q", "dev")
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "aquilla-release-plan-"))
    git("init", "-q", "-b", "dev")
    writeFileSync(path.join(root, "README.md"), "base\n")
    git("add", "-A")
    git("commit", "-qm", "base")
    git("update-ref", "refs/remotes/origin/dev", "dev")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("tag directly on dev: the range is <tag>..origin/dev, as before", () => {
    const m1 = mergePr(1, "docs/one.md")
    mergePr(2, "docs/two.md")
    mergePr(3, "docs/three.md")
    git("tag", "2026.09.28.01", m1)
    const { prs, floor, base } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => p.number)).toEqual([2, 3])
    expect(prs.map((p) => p.behindFloor)).toEqual([false, false])
    expect(floor).toBe(m1)
    expect(base).toBe(m1)
  })

  it("tag on a cherry-pick tip: picked PRs are released; the next slice starts after the newest pick", () => {
    const m1 = mergePr(1, "docs/one.md")
    const m2 = mergePr(2, "docs/two.md")
    const m3 = mergePr(3, "docs/three.md")
    const m4 = mergePr(4, "docs/four.md")
    release(m1, [{ sha: m2 }, { sha: m3 }], "2026.09.28.01")
    const { prs, floor, base } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => p.number)).toEqual([4])
    expect(floor).toBe(m3)
    // The next branch starts at the tagged tip, so the picks of #2 and #3
    // stay in production and #4 is picked on top.
    expect(base).toBe(git("rev-parse", "2026.09.28.01^{commit}"))
    const plan = planRelease({ openReleases: [], prs, now: NOW, base })
    expect(plan.prs.map((p) => p.number)).toEqual([4])
    expect(plan.prs[0].sha).toBe(m4)
  })

  it("mixed: a pick without -x and a hotfix picked ahead of its order", () => {
    const m1 = mergePr(1, "docs/one.md")
    const m2 = mergePr(2, "docs/two.md")
    mergePr(3, "db/postgres/migrations/0001_x.sql")
    const m4 = mergePr(4, "docs/four.md")
    mergePr(5, "docs/five.md")
    release(m1, [{ sha: m2, x: false }, { sha: m4 }], "2026.09.28.02")
    const { prs, floor, base } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => [p.number, p.behindFloor])).toEqual([[3, true], [5, false]])
    expect(floor).toBe(m4)
    // #3 holds on its migration; #5 is picked onto the tagged tip, which
    // already carries the hotfix #4, so nothing leaves production.
    const plan = planRelease({ openReleases: [], prs, now: NOW, base })
    expect(plan.prs.map((p) => p.number)).toEqual([5])
    expect(plan.held.map((p) => p.number)).toEqual([3])
    expect(plan.base).toBe(git("rev-parse", "2026.09.28.02^{commit}"))
  })
})
