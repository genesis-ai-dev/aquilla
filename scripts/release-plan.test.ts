import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  classifyFiles,
  holdReason,
  isDocsOrTestOnly,
  isLocaleCatalogOnly,
  planRelease,
  prHolds,
  prNumberFromSubject,
  releasedMarks,
  splitReleased,
  unreleasedPrs,
  walkHolds,
  walkPolicy,
} from "./release-plan.mjs"
import { holdNudge } from "./release-hold-nudge.mjs"

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

// A commit pushed straight to dev: no PR number, its subject in place of a title.
const direct = (sha: string, subject: string, files: string[], areas: string[] = []) => ({
  sha,
  subject,
  direct: true,
  mergedAt: recent,
  files,
  areas,
  pathHolds: false,
  walk: "unknown",
})
const CATALOGS = ["src/lib/i18n/messages/fr.ts", "src/lib/i18n/messages/zh-Hans.ts", "src/lib/i18n/source-hashes.json"]

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

  it("holds on a failed walk the same way a path hold does", () => {
    const failed = planRelease({ openReleases: [], prs: [pr(1, recent, { walk: "fail" }), pr(2, recent)], now: NOW })
    expect(failed.prs.map((p) => p.number)).toEqual([2])
    expect(failed.held.map((p) => p.number)).toEqual([1])
  })

  // 2026-11-19: 36 of 47 waiting PRs were held for having no walk or a
  // test-level one, and none of those is an outcome that cannot be fixed
  // forward. The default policy ships them; `strict` is the rule as it was.
  it("ships an unwalked or test-level PR by default, and holds both under the strict policy", () => {
    const prs = [pr(1, recent, { walk: "unknown" }), pr(2, recent, { walk: "partial" }), pr(3, recent, { walk: "fail" })]
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.prs.map((p) => p.number)).toEqual([1, 2])
    expect(plan.held.map((p) => p.why)).toEqual(["walk fail"])
    expect(plan.walkPolicy).toBe("fail-only")

    const strict = planRelease({ openReleases: [], prs, now: NOW, policy: "strict" })
    expect(strict.cut).toBe(false)
    expect(strict.held.map((p) => p.why)).toEqual(["walk unknown", "walk partial", "walk fail"])
  })

  it("still lists the held PRs while a release is in flight", () => {
    const plan = planRelease({ openReleases: ["release/2026/09/23-01"], prs: [migration(1, recent), pr(2, recent)], now: NOW })
    expect(plan.cut).toBe(false)
    expect(plan.held.map((p) => [p.number, p.why])).toEqual([[1, "touches migration"]])
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

  // The cut names the held PR a pick that did not land was built on from
  // these, with no GitHub call of its own.
  it("carries each PR's files through to the ready and held lists", () => {
    const prs = [{ ...pr(1, recent), files: ["src/a.ts"] }, { ...migration(2, recent), files: ["db/postgres/migrations/0199_x.sql"] }]
    const plan = planRelease({ openReleases: [], prs, now: NOW })
    expect(plan.prs[0].files).toEqual(["src/a.ts"])
    expect(plan.held[0].files).toEqual(["db/postgres/migrations/0199_x.sql"])
  })

  // Until 2026-11-20 the planner skipped every commit with no PR number. Six
  // daily localization pushes never reached the release line, and each PR
  // that appended locale keys after them conflicted on every hourly cut.
  it("plans a direct commit in its dev position: catalog-only is ready, anything else is held as not a PR", () => {
    const catalogs = direct("c0ffee0001", "chore(i18n): localize labels", CATALOGS)
    // Neither a label nor a walk can clear it: there is no PR to carry either.
    const bump = { ...direct("b0b0b0b0b0", "chore(desktop): bump shell", ["src-tauri/tauri.conf.json"]), approved: true, walk: "PASS" }
    const plan = planRelease({ openReleases: [], prs: [pr(1, recent), catalogs, bump, pr(2, recent)], now: NOW })
    expect(plan.prs.map((p) => p.number ?? p.sha)).toEqual([1, "c0ffee0001", 2])
    expect(plan.held).toEqual([expect.objectContaining({ sha: "b0b0b0b0b0", subject: "chore(desktop): bump shell", why: "not a PR" })])
    expect(plan.reason).toBe("2 ready PR(s) and 1 direct commit(s), 1 held, no release in flight")
    expect([plan.prCount, plan.directCount]).toEqual([2, 2])

    const waiting = planRelease({ openReleases: [], prs: [bump], now: NOW })
    expect(waiting.cut).toBe(false)
    expect(waiting.reason).toBe("0 PR(s) and 1 direct commit(s) waiting on a person, none ready")
    expect(waiting.held.map((p) => p.sha)).toEqual(["b0b0b0b0b0"])
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

  it("a missing walk does not excuse an ungated holding area", () => {
    expect(prHolds({ areas: ["auth"], walk: "unknown" })).toBe(true)
    expect(prHolds({ areas: ["auth"], walk: "unknown", gates: ["auth"] })).toBe(false)
  })

  it("decides a direct commit from its files alone, and names its holding areas in the reason", () => {
    expect(prHolds(direct("a", "chore(i18n): localize", CATALOGS))).toBe(false)
    expect(prHolds(direct("b", "docs: fix a typo", ["docs/SEO.md"]))).toBe(true)
    expect(prHolds({ direct: true, areas: [], walk: "none" })).toBe(true)
    expect(holdReason(direct("c", "chore: bump", ["package.json"]))).toBe("not a PR")
    expect(holdReason(direct("d", "add a column", ["db/postgres/migrations/0199_x.sql"], ["migration"]))).toBe("not a PR; touches migration")
  })
})

// The one kind of direct commit the line picks by itself: the generated
// catalogs and their sidecar, nothing a person wrote.
describe("isLocaleCatalogOnly", () => {
  it.each([
    [CATALOGS, true],
    [["src/lib/i18n/source-hashes.json"], true],
    [[], false],
    // The English source, the registries a new locale edits, and tests are code.
    [["src/lib/i18n/messages/fr.ts", "src/lib/i18n/messages/en.ts"], false],
    [["src/lib/i18n/messages/fr.ts", "src/lib/i18n/messages/index.ts"], false],
    [["src/lib/i18n/messages/all.ts"], false],
    [["src/lib/i18n/messages/index.test.ts"], false],
    [["src/lib/i18n/messages/fr.ts", "src/lib/i18n/namespaces/org.ts"], false],
    [["src/lib/i18n/messages/nested/fr.ts"], false],
    [["docs/src/lib/i18n/source-hashes.json"], false],
  ])("%j is %s", (files, expected) => {
    expect(isLocaleCatalogOnly(files)).toBe(expected)
  })
})

describe("walk policy", () => {
  it.each([
    ["PASS", false, false],
    ["none", false, false],
    ["unknown", false, true],
    ["partial", false, true],
    ["fail", true, true],
  ])("%s: holds under fail-only %s, under strict %s", (walk, failOnly, strict) => {
    expect(walkHolds(walk, "fail-only")).toBe(failOnly)
    expect(walkHolds(walk, "strict")).toBe(strict)
  })

  it("reads WALK_POLICY, and anything else is the default", () => {
    expect(walkPolicy({ WALK_POLICY: "strict" })).toBe("strict")
    expect(walkPolicy({ WALK_POLICY: "Strict" })).toBe("fail-only")
    expect(walkPolicy({})).toBe("fail-only")
  })
})

// One line per PR, in the hour its wait crosses the limit: on 2026-11-19 the
// line had 47 PRs behind it for two days and nothing said so.
describe("holdNudge", () => {
  const held = (number: number, mergedAt: string, why = "touches infra") => ({ number, mergedAt, why })
  const plan = {
    held: [
      held(1, "2026-11-17T09:30:00Z"),
      held(2, "2026-11-19T07:40:00Z", "touches migration"),
      held(3, "2026-11-19T10:30:00Z", "walk fail"),
    ],
  }

  it("names the PR that crossed the limit this hour, with the count and the oldest", () => {
    expect(holdNudge(plan, "2026-11-19T12:05:00Z")).toBe(
      "⏳ Held 4 h, not in production: #2 (touches migration). 2 merged changes have now waited that long; the oldest is #1, 2 d. A green gate or the `release:approved` label puts a PR on the next cut; a direct commit waits for a person to pick it.",
    )
  })

  it("says nothing in an hour no PR crossed it, however many are waiting", () => {
    expect(holdNudge(plan, "2026-11-19T13:05:00Z")).toBeNull()
    expect(holdNudge({ held: [] }, "2026-11-19T12:05:00Z")).toBeNull()
  })

  it("reads merge times across UTC offsets as instants", () => {
    expect(holdNudge({ held: [held(9, "2026-11-19T02:10:00-06:00")] }, "2026-11-19T12:15:00Z")).toContain("#9 (touches infra)")
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
  // A commit pushed straight to dev: no PR branch, no merge, any subject.
  const directCommit = (subject: string, files: Record<string, string>) => {
    git("checkout", "-q", "dev")
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    git("add", "-A")
    git("commit", "-qm", subject)
    git("update-ref", "refs/remotes/origin/dev", "dev")
    return git("rev-parse", "HEAD")
  }
  // A release branch cut at `at`, built the documented way, then tagged. A
  // direct commit has one parent, so its pick takes no -m 1.
  const release = (at: string, picks: { sha: string; x?: boolean; merge?: boolean }[], tag: string) => {
    git("checkout", "-q", "-b", `release/${tag.slice(0, 10).replaceAll(".", "/")}-01`, at)
    for (const { sha, x = true, merge = true } of picks) git("cherry-pick", ...(x ? ["-x"] : []), ...(merge ? ["-m", "1"] : []), sha)
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
    expect(prs.map((p) => p.files)).toEqual([["docs/two.md"], ["docs/three.md"]])
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

  it("lists direct commits between the PRs, in dev order, and leaves out only a merge that changed no file", () => {
    const m1 = mergePr(1, "src/app.ts")
    git("tag", "2026.09.28.01", m1)
    const catalogs = directCommit("chore(i18n): localize labels", {
      "src/lib/i18n/messages/fr.ts": "fr\n",
      "src/lib/i18n/source-hashes.json": "{}\n",
    })
    mergePr(2, "docs/two.md")
    const bump = directCommit("chore(desktop): bump shell", { "src-tauri/tauri.conf.json": "0.2.3\n" })
    // Nobody reviewed it, so a rename's old path counts: this one moves app
    // code onto a catalog path, and is not a catalog-only commit.
    git("mv", "src/app.ts", "src/lib/i18n/messages/de.ts")
    git("commit", "-qm", "chore(i18n): add de")
    const rename = git("rev-parse", "HEAD")
    // A branch merged back with nothing dev lacked: there is nothing to pick.
    git("checkout", "-q", "-b", "backmerge", m1)
    git("commit", "-q", "--allow-empty", "-m", "marker")
    git("checkout", "-q", "dev")
    git("merge", "-q", "--no-ff", "-m", "Merge branch 'main' into dev", "backmerge")
    git("update-ref", "refs/remotes/origin/dev", "dev")

    const { prs, base } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => [p.number ?? p.subject, p.sha, p.direct ?? false, p.walk])).toEqual([
      ["chore(i18n): localize labels", catalogs, true, "none"],
      [2, expect.any(String), false, "none"],
      ["chore(desktop): bump shell", bump, true, "unknown"],
      ["chore(i18n): add de", rename, true, "unknown"],
    ])
    expect(prs[0].files).toEqual(["src/lib/i18n/messages/fr.ts", "src/lib/i18n/source-hashes.json"])
    expect(prs[3].files).toEqual(["src/app.ts", "src/lib/i18n/messages/de.ts"])

    const plan = planRelease({ openReleases: [], prs, now: NOW, base })
    expect(plan.prs.map((p) => p.number ?? p.sha)).toEqual([catalogs, 2])
    expect(plan.held.map((p) => [p.sha, p.why])).toEqual([[bump, "not a PR"], [rename, "not a PR"]])
  })

  // How a person releases a held direct commit: a pick by hand onto the
  // release branch. Only -x proves it; a direct commit has no PR number in
  // its subject to fall back on. #2 sits between the cut point and the
  // commit, so the pick is ahead of its dev order, like a hotfix.
  it.each([
    { x: true, waiting: [2, 3], floorIsBump: true },
    { x: false, waiting: [2, "chore(desktop): bump shell", 3], floorIsBump: false },
  ])("a direct commit picked by hand is released, and moves the floor, only with -x ($x)", ({ x, waiting, floorIsBump }) => {
    const m1 = mergePr(1, "docs/one.md")
    mergePr(2, "docs/two.md")
    const bump = directCommit("chore(desktop): bump shell", { "src-tauri/tauri.conf.json": "0.2.3\n" })
    mergePr(3, "docs/three.md")
    release(m1, [{ sha: bump, x, merge: false }], "2026.09.28.01")
    const { prs, floor } = unreleasedPrs({ cwd: root })
    expect(prs.map((p) => p.number ?? p.subject)).toEqual(waiting)
    expect(prs[0].behindFloor).toBe(floorIsBump)
    expect(floor).toBe(floorIsBump ? bump : m1)
  })
})
