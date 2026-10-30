import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildReleaseBranch, releaseNotes } from "./release-cut.mjs"

const plan = {
  cut: true,
  reason: "4 ready PR(s), 0 held, no release in flight",
  branch: "release/2026/09/24-02",
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
      held: [{ number: 800, why: "touches migration" }, { number: 802, why: "walk fail" }, { number: 803, why: "pick conflict" }],
    }
    const notes = releaseNotes(withHeld, { 801: "Add a column | safely" })
    expect(notes).toContain("## Release release/2026/09/24-02 · 1 PRs\n\n")
    expect(notes).toContain("| #801 | Add a column \\| safely | PASS | — |")
    expect(notes).toContain("**Held, not in this release:** #800 (touches migration), #802 (walk fail), #803 (pick conflict).")
    expect(notes).toMatch(/release:approved/)
  })

  it("prints a placeholder when a title could not be fetched", () => {
    expect(releaseNotes(plan, {})).toContain("| #771 | (title unavailable) | PASS | — |")
  })
})

// The cut picks ready PRs onto the tagged tip. A conflicting pick is the one
// thing a path-based hold cannot see coming (a ready PR built on a held
// one), so it has to come out as a held PR, not a failed run.
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
    expect(built.conflicts).toEqual([])
    expect(built.picked.map((p) => p.number)).toEqual([1, 2])
    expect(git("rev-parse", "release/2026/09/29-01")).toBe(built.sha)
    const log = git("log", "--format=%s%n%b", `${base}..${built.sha}`)
    expect(log).toContain(`(cherry picked from commit ${m1})`)
    expect(log).toContain(`(cherry picked from commit ${s2})`)
    expect(git("show", `${built.sha}:docs/two.md`)).toBe("2")
  })

  it("skips a ready PR built on a held one when its pick conflicts, and keeps going", () => {
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
    expect(built.conflicts).toEqual([{ number: 2, sha: dependent, why: "pick conflict" }])
    expect(git("status", "--porcelain")).toBe("")
    expect(git("show", `${built.sha}:README.md`)).toBe("base")
    expect(held).not.toBe(built.sha)
  })
})
