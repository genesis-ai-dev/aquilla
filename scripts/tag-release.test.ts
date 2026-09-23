import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const SCRIPT = path.join(import.meta.dirname, "tag-release.sh")

// The calver tag is the only link between a live production version and the
// commit QA approved, so numbering must be monotonic and never double-claimed.
describe("tag-release.sh", () => {
  let root: string
  let origin: string
  let work: string

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const run = (cwd = work) =>
    spawnSync("bash", [SCRIPT], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  const commit = (msg: string) => git(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", msg)
  const originTags = () => git(origin, "tag", "--list").split("\n").filter(Boolean).sort()

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "aquilla-tag-release-"))
    origin = path.join(root, "origin.git")
    work = path.join(root, "work")
    git(root, "init", "-q", "--bare", origin)
    git(root, "init", "-q", "-b", "release/2026/09/23", work)
    git(work, "remote", "add", "origin", origin)
    git(work, "config", "user.email", "t@t")
    git(work, "config", "user.name", "t")
    commit("first")
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("starts a new series at 00 and pushes it", () => {
    expect(run().status).toBe(0)
    expect(originTags()).toEqual(["2026.09.23.00"])
  })

  it("increments for each newly deployed commit, including hotfixes", () => {
    run()
    commit("hotfix")
    expect(run().status).toBe(0)
    expect(originTags()).toEqual(["2026.09.23.00", "2026.09.23.01"])
  })

  it("reuses the existing tag when the same commit is redeployed", () => {
    run()
    const again = run()
    expect(again.status).toBe(0)
    expect(again.stdout).toContain("already tagged 2026.09.23.00")
    expect(originTags()).toEqual(["2026.09.23.00"])
  })

  it("counts tags that exist only on origin", () => {
    git(work, "tag", "2026.09.23.07")
    git(work, "push", "-q", "origin", "refs/tags/2026.09.23.07")
    git(work, "tag", "-d", "2026.09.23.07")
    commit("next")
    expect(run().status).toBe(0)
    expect(originTags()).toContain("2026.09.23.08")
  })

  it("numbers past 09 without breaking on octal parsing", () => {
    git(work, "tag", "2026.09.23.09")
    git(work, "push", "-q", "origin", "refs/tags/2026.09.23.09")
    commit("next")
    expect(run().status).toBe(0)
    expect(originTags()).toContain("2026.09.23.10")
  })

  it("refuses to tag from a non-release branch", () => {
    git(work, "checkout", "-q", "-b", "dev")
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("release/YYYY/MM/DD")
    expect(originTags()).toEqual([])
  })
})
