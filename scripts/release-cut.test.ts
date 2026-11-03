import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildReleaseBranch, cutSummary, dependencyHint, releaseNotes, unpickedReport } from "./release-cut.mjs"

const plan = {
  cut: true,
  reason: "4 ready PR(s), 0 held, no release in flight",
  branch: "release/2026/09/24-02",
  base: "b45e",
  areas: ["sync"],
  prs: [
    { number: 771, walk: "PASS", areas: [] },
    { number: 772, walk: "PASS", areas: ["sync"] },
    { number: 773, walk: "PASS", areas: [] },
    { number: 774, walk: "none", areas: [] },
  ],
  held: [],
}

describe("releaseNotes", () => {
  it("follows RELEASE-CUT.md's template", () => {
    const titles = { 771: "Remove Inworld companion preset", 772: "Comment thread polish", 773: "Export raw mode fix", 774: "Retention tab copy" }
    expect(releaseNotes(plan, titles)).toBe([
      "## Release release/2026/09/24-02 · 4 PRs · areas: sync",
      "",
      "| PR | Title | Walk @ head sha | Areas |",
      "| --- | --- | --- | --- |",
      "| #771 | Remove Inworld companion preset | PASS | — |",
      "| #772 | Comment thread polish | PASS | sync |",
      "| #773 | Export raw mode fix | PASS | — |",
      "| #774 | Retention tab copy | none (docs only) | — |",
    ].join("\n"))
  })

  it("lists the held PRs with why, after the table, and drops empty areas", () => {
    const withHeld = {
      ...plan,
      areas: [],
      prs: [{ number: 801, walk: "PASS", areas: [] }],
      held: [
        { number: 800, why: "touches migration" },
        { number: 802, why: "walk fail" },
        { number: 803, why: "pick conflict in src/lib/i18n/namespaces/org.ts; needs #800" },
        { number: 804, why: "empty pick: already in base, or needs a held PR" },
      ],
    }
    const notes = releaseNotes(withHeld, { 801: "Add a column | safely" })
    expect(notes).toContain("## Release release/2026/09/24-02 · 1 PRs\n\n")
    expect(notes).toContain("| #801 | Add a column \\| safely | PASS | — |")
    expect(notes).toContain(
      "**Held, not in this release:** #800 (touches migration), #802 (walk fail), #803 (pick conflict in src/lib/i18n/namespaces/org.ts; needs #800), #804 (empty pick: already in base, or needs a held PR).",
    )
    expect(notes).toMatch(/release:approved/)
  })

  it("prints a placeholder when a title could not be fetched", () => {
    expect(releaseNotes(plan, {})).toContain("| #771 | (title unavailable) | PASS | — |")
  })
})

// Since 2026-10-31 every hourly run ended in "No cut: every ready PR
// conflicted with the base" while one of the two "conflicts" was an empty
// pick. The summary now carries each PR's own reason, so a person can act
// on it (approve the held PR it names) without a scratch worktree.
describe("cutSummary", () => {
  const unpicked = [
    { number: 1744, why: "pick conflict in src/lib/i18n/namespaces/org.ts; needs #1743" },
    { number: 1752, why: "empty pick: already in base, or needs #1750" },
  ]

  it("lists each unpicked PR with its reason when nothing could be picked", () => {
    expect(cutSummary({ ...plan, prs: [{}, {}] }, { sha: "b45e", picked: [], unpicked })).toBe([
      "No cut: none of the 2 ready PR(s) could be picked onto `b45e`:",
      "- #1744: pick conflict in src/lib/i18n/namespaces/org.ts; needs #1743",
      "- #1752: empty pick: already in base, or needs #1750",
    ].join("\n"))
  })

  it("says what landed and what did not when some picks landed", () => {
    expect(cutSummary(plan, { sha: "c0ffee", picked: [{}, {}, {}], unpicked })).toBe([
      "Cut `release/2026/09/24-02` at `c0ffee` (3 picked onto `b45e`, 2 not picked).",
      "",
      "Not picked by this cut:",
      "- #1744: pick conflict in src/lib/i18n/namespaces/org.ts; needs #1743",
      "- #1752: empty pick: already in base, or needs #1750",
    ].join("\n"))
  })

  it("is one line when every pick landed", () => {
    expect(cutSummary(plan, { sha: "c0ffee", picked: [{}], unpicked: [] })).toBe("Cut `release/2026/09/24-02` at `c0ffee` (1 picked onto `b45e`).")
    expect(unpickedReport([])).toBe("")
  })
})

// The hint comes from the files the plan already carries per PR, never a
// GitHub call: the planner's slicing stays network-free.
describe("dependencyHint", () => {
  const at = (hour: number) => `2026-10-31T${String(hour).padStart(2, "0")}:00:00Z`
  const held = [
    { number: 1740, sha: "a", mergedAt: at(8), files: ["src/lib/i18n/namespaces/org.ts", "docs/x.md"] },
    { number: 1743, sha: "b", mergedAt: at(10), files: ["src/lib/i18n/namespaces/org.ts"] },
    { number: 1750, sha: "c", mergedAt: at(14), files: ["src/lib/i18n/namespaces/org.ts"] },
  ]

  it("names the newest held PR merged before the pick that touched a conflicted path", () => {
    const pr = { number: 1744, sha: "d", mergedAt: at(12) }
    expect(dependencyHint(pr, ["src/lib/i18n/namespaces/org.ts"], held)).toBe(1743)
  })

  it("never names a PR merged after the pick, or the pick itself", () => {
    const pr = { number: 1741, sha: "d", mergedAt: at(9), files: ["src/lib/i18n/namespaces/org.ts"] }
    expect(dependencyHint(pr, ["src/lib/i18n/namespaces/org.ts"], [...held, pr])).toBe(1740)
  })

  // The planner writes mergedAt with each merge's own UTC offset, and dev's
  // merges come from several time zones: "newest" is by instant, not by
  // string. Here the string order is the reverse of the time order.
  it("orders candidates by instant, not by the mergedAt string", () => {
    const candidates = [
      { number: 10, sha: "a", mergedAt: "2026-10-30T20:00:00-04:00", files: ["src/x.ts"] }, // 00:00Z Oct 31
      { number: 11, sha: "b", mergedAt: "2026-10-30T19:00:00-07:00", files: ["src/x.ts"] }, // 02:00Z Oct 31
    ]
    const pr = { number: 12, sha: "c", mergedAt: "2026-10-30T22:00:00-06:00" } // 04:00Z Oct 31
    expect(dependencyHint(pr, ["src/x.ts"], candidates)).toBe(11)
    expect(dependencyHint({ number: 13, sha: "d", mergedAt: "2026-10-31T01:00:00Z" }, ["src/x.ts"], candidates)).toBe(10)
  })

  it("is undefined when no held PR touched the paths, or the plan carries no files", () => {
    const pr = { number: 1744, sha: "d", mergedAt: at(12) }
    expect(dependencyHint(pr, ["src/other.ts"], held)).toBeUndefined()
    expect(dependencyHint(pr, ["src/lib/i18n/namespaces/org.ts"], [{ number: 1743, sha: "b", mergedAt: at(10) }])).toBeUndefined()
  })
})

// The cut picks ready PRs onto the tagged tip. A pick that does not land is
// the one thing a path-based hold cannot see coming (a ready PR built on a
// held one), so it has to come out as a held PR with a reason a person can
// act on, not a failed run and not a bare "pick conflict".
describe("buildReleaseBranch against a scratch repo", () => {
  let root: string
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
    }).trim()
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  const mergePr = (number: number, file: string, text = `${number}\n`) => {
    git("checkout", "-q", "-b", `pr-${number}`, "dev")
    write(file, text)
    git("add", "-A")
    git("commit", "-qm", `AQU-${number}: change`)
    git("checkout", "-q", "dev")
    git("merge", "-q", "--no-ff", "-m", `Merge pull request #${number} from genesis-ai-dev/agent/AQU-${number}`, `pr-${number}`)
    return git("rev-parse", "HEAD")
  }
  const squashPr = (number: number, file: string) => {
    git("checkout", "-q", "dev")
    write(file, `${number}\n`)
    git("add", "-A")
    git("commit", "-qm", `AQU-${number}: squashed (#${number})`)
    return git("rev-parse", "HEAD")
  }
  // Dev order for the hint: PR #n merged at hour n.
  const at = (number: number) => `2026-10-31T${String(number).padStart(2, "0")}:00:00Z`
  const nothingInProgress = () => {
    expect(git("status", "--porcelain")).toBe("")
    expect(() => git("rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD")).toThrow()
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "aquilla-release-cut-"))
    git("init", "-q", "-b", "dev")
    // buildReleaseBranch runs plain git, so the pick's commit needs an
    // identity in the repo itself (a CI runner has none configured).
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    write("README.md", "base\n")
    git("add", "-A")
    git("commit", "-qm", "base")
    git("tag", "2026.09.28.01")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("picks merge and squash commits onto the base with -x provenance, in order", () => {
    const base = git("rev-parse", "2026.09.28.01")
    const m1 = mergePr(1, "docs/one.md")
    const s2 = squashPr(2, "docs/two.md")
    const built = buildReleaseBranch({ branch: "release/2026/09/29-01", base, prs: [{ number: 1, sha: m1 }, { number: 2, sha: s2 }], cwd: root })
    expect(built.unpicked).toEqual([])
    expect(built.picked.map((p) => p.number)).toEqual([1, 2])
    expect(git("rev-parse", "release/2026/09/29-01")).toBe(built.sha)
    const log = git("log", "--format=%s%n%b", `${base}..${built.sha}`)
    expect(log).toContain(`(cherry picked from commit ${m1})`)
    expect(log).toContain(`(cherry picked from commit ${s2})`)
    expect(git("show", `${built.sha}:docs/two.md`)).toBe("2")
  })

  it("skips a ready PR built on a held one when its pick conflicts, names the paths, and keeps going", () => {
    const base = git("rev-parse", "2026.09.28.01")
    const held = mergePr(1, "README.md", "rewritten by migration PR\n")
    const dependent = mergePr(2, "README.md", "rewritten by migration PR\nand then by #2\n")
    const independent = mergePr(3, "docs/three.md")
    const built = buildReleaseBranch({
      branch: "release/2026/09/29-01",
      base,
      prs: [{ number: 2, sha: dependent }, { number: 3, sha: independent }],
      cwd: root,
    })
    expect(built.picked.map((p) => p.number)).toEqual([3])
    // No held list handed in: the paths are known, the PR behind them is not.
    expect(built.unpicked).toEqual([{ number: 2, sha: dependent, kind: "conflict", paths: ["README.md"], why: "pick conflict in README.md" }])
    nothingInProgress()
    expect(git("show", `${built.sha}:README.md`)).toBe("base")
    expect(held).not.toBe(built.sha)
  })

  it("names the held PR a conflicting pick was built on, from the plan's files, and chains through earlier unpicked PRs", () => {
    const base = git("rev-parse", "2026.09.28.01")
    const held = mergePr(1, "README.md", "rewritten by migration PR\n")
    const dependent = mergePr(2, "README.md", "rewritten by migration PR\nand then by #2\n")
    const grandchild = mergePr(3, "README.md", "rewritten by migration PR\nand then by #2\nand by #3\n")
    const independent = mergePr(4, "docs/four.md")
    const built = buildReleaseBranch({
      branch: "release/2026/09/29-01",
      base,
      prs: [
        { number: 2, sha: dependent, mergedAt: at(2), files: ["README.md"] },
        { number: 3, sha: grandchild, mergedAt: at(3), files: ["README.md"] },
        { number: 4, sha: independent, mergedAt: at(4), files: ["docs/four.md"] },
      ],
      held: [{ number: 1, sha: held, mergedAt: at(1), files: ["README.md"] }],
      cwd: root,
    })
    expect(built.picked.map((p) => p.number)).toEqual([4])
    expect(built.unpicked.map((p) => [p.number, p.kind, p.paths, p.needs, p.why])).toEqual([
      [2, "conflict", ["README.md"], 1, "pick conflict in README.md; needs #1"],
      // #3 was built on #2, which this cut left behind: that is the PR it
      // needs, not the migration two steps back.
      [3, "conflict", ["README.md"], 2, "pick conflict in README.md; needs #2"],
    ])
    nothingInProgress()
  })

  // #1752 on 2026-11-02: without its held parent the pick had nothing to
  // commit, git exited 1, and the cut filed it as a conflict. It is not
  // one, and it must not vanish either: it is held with its own reason.
  it("holds an empty pick as such, skips it without committing, and names the held PR it needs", () => {
    const base = git("rev-parse", "2026.09.28.01")
    const held = mergePr(1, "README.md", "rewritten by migration PR\n")
    // A revert of the held PR: against the base the change is nothing.
    const revert = mergePr(2, "README.md", "base\n")
    const independent = mergePr(3, "docs/three.md")
    const built = buildReleaseBranch({
      branch: "release/2026/09/29-01",
      base,
      prs: [
        { number: 2, sha: revert, mergedAt: at(2), files: ["README.md"] },
        { number: 3, sha: independent, mergedAt: at(3), files: ["docs/three.md"] },
      ],
      held: [{ number: 1, sha: held, mergedAt: at(1), files: ["README.md"] }],
      cwd: root,
    })
    expect(built.picked.map((p) => p.number)).toEqual([3])
    expect(built.unpicked).toEqual([
      { number: 2, sha: revert, mergedAt: at(2), files: ["README.md"], kind: "empty", paths: [], needs: 1, why: "empty pick: already in base, or needs #1" },
    ])
    nothingInProgress()
    // Nothing committed for #2: an empty commit with -x provenance would
    // tell the planner production carries it.
    expect(git("log", "--format=%s", `${base}..${built.sha}`)).toBe("Merge pull request #3 from genesis-ai-dev/agent/AQU-3")
    expect(git("show", `${built.sha}:README.md`)).toBe("base")
  })

  it("holds an empty pick whose change the base already carries, with no PR to name", () => {
    // A hotfix committed straight onto the release line and tagged, then
    // merged to dev as its own PR with another sha.
    git("checkout", "-q", "-b", "hotfix", "2026.09.28.01")
    write("docs/hot.md", "fix\n")
    git("add", "-A")
    git("commit", "-qm", "hotfix")
    git("tag", "2026.09.28.02")
    git("checkout", "-q", "dev")
    const base = git("rev-parse", "2026.09.28.02")
    const twin = mergePr(1, "docs/hot.md", "fix\n")
    const built = buildReleaseBranch({
      branch: "release/2026/09/29-01",
      base,
      prs: [{ number: 1, sha: twin, mergedAt: at(1), files: ["docs/hot.md"] }],
      held: [],
      cwd: root,
    })
    expect(built.picked).toEqual([])
    expect(built.unpicked.map((p) => [p.kind, p.why])).toEqual([["empty", "empty pick: already in base, or needs a held PR"]])
    expect(built.sha).toBe(base)
    nothingInProgress()
  })

  it("fails loud on a bad sha instead of filing it as the PR's", () => {
    const base = git("rev-parse", "2026.09.28.01")
    const bad = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    expect(() => buildReleaseBranch({ branch: "release/2026/09/29-01", base, prs: [{ number: 9, sha: bad }], cwd: root })).toThrow(/bad object/)
    nothingInProgress()
  })

  // A pick that staged its change and then could not commit (the CI
  // runner with no git identity) is not an empty pick, even though it too
  // has no unmerged paths. The identity cannot be taken away from here
  // (vitest's process.env never reaches git), so a repo-local signing
  // setup that cannot run stands in: the pick applies, then the commit fails.
  it("fails loud when the pick cannot commit, and leaves nothing in progress", () => {
    const base = git("rev-parse", "2026.09.28.01")
    const m1 = mergePr(1, "docs/one.md")
    git("config", "commit.gpgsign", "true")
    git("config", "gpg.program", path.join(root, "no-such-gpg"))
    expect(() => buildReleaseBranch({ branch: "release/2026/09/29-01", base, prs: [{ number: 1, sha: m1 }], cwd: root })).toThrow(/gpg/)
    nothingInProgress()
    expect(git("rev-parse", "release/2026/09/29-01")).toBe(base)
  })
})
