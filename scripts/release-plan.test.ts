import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  classifyFiles,
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
    const { pathHolds } = classifyFiles(files)
    expect(pathHolds).toBe(true)
    expect(prHolds({ pathHolds, walk: "PASS" })).toBe(true)
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
    ["scripts/tag-metadata.mjs", "infra", true],
    ["scripts/verify-deploy-branch.sh", "infra", true],
    ["scripts/verify-dist-host.sh", "infra", true],
    ["scripts/verify-live-environment.mjs", "infra", true],
    ["scripts/verify-worker-deployment.mjs", "infra", true],
    ["scripts/verify-deployment-artifacts.mjs", "infra", true],
    ["scripts/record-github-deployment.mjs", "infra", true],
    ["scripts/assert-workers-build-env.mjs", "infra", true],
    ["scripts/ci-build.sh", "infra", true],
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

describe("planRelease with a deploy floor", () => {
  type Opts = Parameters<typeof pr>[2]
  const behind = (number: number, opts?: Opts) => ({ ...pr(number, recent, opts), sha: devSha(number), behindFloor: true })
  const ahead = (number: number, opts?: Opts) => ({ ...pr(number, recent, opts), sha: devSha(number), behindFloor: false })
  const floor = devSha(912)

  it("never cuts below the floor: a ready run that ends behind it cuts at the floor", () => {
    const plan = planRelease({ openReleases: [], prs: [behind(900), behind(911)], now: NOW, floor })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(false)
    expect(plan.sha).toBe(floor)
    expect(plan.prs.map((p) => p.number)).toEqual([900, 911])
    expect(plan.floor).toBe(floor)
  })

  it("a run that reaches past the floor cuts at its own tail", () => {
    const plan = planRelease({ openReleases: [], prs: [behind(900), behind(911), ahead(920)], now: NOW, floor })
    expect(plan.sha).toBe(devSha(920))
    expect(plan.prs).toHaveLength(3)
  })

  it("a hold behind the floor cuts every PR behind the floor together, at the floor, held", () => {
    const prs = [behind(900), behind(776, { areas: ["migration"], pathHolds: true }), behind(911), ahead(920)]
    const plan = planRelease({ openReleases: [], prs, now: NOW, floor })
    expect(plan.cut).toBe(true)
    expect(plan.hold).toBe(true)
    expect(plan.sha).toBe(floor)
    expect(plan.prs.map((p) => p.number)).toEqual([900, 776, 911])
    expect(plan.reason).toBe("a PR behind the deployed floor holds")
  })

  it("with nothing behind the floor the oldest-holds rule is unchanged", () => {
    const prs = [ahead(920, { areas: ["migration"], pathHolds: true }), ahead(921)]
    const plan = planRelease({ openReleases: [], prs, now: NOW, floor })
    expect(plan.hold).toBe(true)
    expect(plan.sha).toBe(devSha(920))
    expect(plan.prs.map((p) => p.number)).toEqual([920])
    expect(plan.reason).toBe("oldest unreleased PR holds")
  })

  it("does not leak the flag into the reported PRs", () => {
    const plan = planRelease({ openReleases: [], prs: [behind(900)], now: NOW, floor })
    expect(plan.prs[0]).not.toHaveProperty("behindFloor")
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
    const { prs, floor } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => p.number)).toEqual([2, 3])
    expect(prs.map((p) => p.behindFloor)).toEqual([false, false])
    expect(floor).toBe(m1)
  })

  it("tag on a cherry-pick tip: picked PRs are released; the next slice starts after the newest pick", () => {
    const m1 = mergePr(1, "docs/one.md")
    const m2 = mergePr(2, "docs/two.md")
    const m3 = mergePr(3, "docs/three.md")
    const m4 = mergePr(4, "docs/four.md")
    release(m1, [{ sha: m2 }, { sha: m3 }], "2026.09.28.01")
    const { prs, floor } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => p.number)).toEqual([4])
    expect(floor).toBe(m3)
    // Before the fix this cut #2 alone, at a dev commit production already ran.
    const plan = planRelease({ openReleases: [], prs, now: NOW, floor })
    expect(plan.prs.map((p) => p.number)).toEqual([4])
    expect(plan.sha).toBe(m4)
  })

  it("mixed: a pick without -x and a hotfix picked ahead of its order", () => {
    const m1 = mergePr(1, "docs/one.md")
    const m2 = mergePr(2, "docs/two.md")
    mergePr(3, "db/postgres/migrations/0001_x.sql")
    const m4 = mergePr(4, "docs/four.md")
    mergePr(5, "docs/five.md")
    release(m1, [{ sha: m2, x: false }, { sha: m4 }], "2026.09.28.02")
    const { prs, floor } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => [p.number, p.behindFloor])).toEqual([[3, true], [5, false]])
    expect(floor).toBe(m4)
    // #3 holds on its migration and sits behind the deployed hotfix #4, so
    // the held slice cuts at #4's dev merge, not #3's: cutting at #3 would
    // take the hotfix back out of production.
    const plan = planRelease({ openReleases: [], prs, now: NOW, floor })
    expect(plan.hold).toBe(true)
    expect(plan.prs.map((p) => p.number)).toEqual([3])
    expect(plan.sha).toBe(m4)
  })
})
