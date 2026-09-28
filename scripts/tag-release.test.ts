import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  let recorded: string

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
    return r.stdout.trim()
  }
  // The real recorder writes to genesis-ai-dev/aquilla with the caller's gh
  // token. The stub only notes which sha it was asked to record.
  const env = () => ({
    ...process.env,
    GITHUB_TOKEN: "test-token",
    TAG_RELEASE_RECORD_DEPLOYMENT: path.join(root, "record-stub.mjs"),
  })
  const run = (cwd = work) =>
    spawnSync("bash", [SCRIPT], { cwd, encoding: "utf8", env: env() })
  const commit = (msg: string) => git(work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", msg)
  const originTags = () => git(origin, "tag", "--list").split("\n").filter(Boolean).sort()

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "aquilla-tag-release-"))
    origin = path.join(root, "origin.git")
    work = path.join(root, "work")
    recorded = path.join(root, "recorded.txt")
    writeFileSync(
      path.join(root, "record-stub.mjs"),
      `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(recorded)}, process.argv.slice(2).join(" ") + "\\n")\n`,
    )
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

  it("records the production deployment for HEAD before pushing", () => {
    expect(run().status).toBe(0)
    expect(readFileSync(recorded, "utf8")).toBe(`${git(work, "rev-parse", "HEAD")} production\n`)
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

  it("stops at once when a GitHub ruleset rejects the push", () => {
    // A pre-receive hook stands in for GitHub's "release tags" ruleset.
    const hook = path.join(origin, "hooks", "pre-receive")
    writeFileSync(hook, "#!/bin/sh\necho 'error: GH013: Repository rule violations found for refs/tags/2026.09.23.00.' >&2\nexit 1\n")
    chmodSync(hook, 0o755)
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("GH013")
    expect(result.stderr).toContain("GitHub's rules rejected 2026.09.23.00")
    expect(result.stderr).not.toContain("retrying")
    expect(git(work, "tag", "--list")).toBe("")
    expect(originTags()).toEqual([])
  })

  it("refuses to tag from a non-release branch", () => {
    git(work, "checkout", "-q", "-b", "dev")
    const result = run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("release/YYYY/MM/DD")
    expect(originTags()).toEqual([])
  })

  it("includes preview URL and metadata in the annotated tag message", () => {
    const result = run()
    expect(result.status).toBe(0)
    const tagMessage = git(work, "tag", "-l", "--format=%(contents)", "2026.09.23.00")
    expect(tagMessage).toContain("Production release 2026.09.23.00")
    expect(tagMessage).toContain("Release branch: release/2026/09/23")
    expect(tagMessage).toContain("Deployed commit:")
    expect(tagMessage).toContain("Commit URL: https://github.com/genesis-ai-dev/aquilla/commit/")
    expect(tagMessage).toContain("Checks URL: https://github.com/genesis-ai-dev/aquilla/commit/")
    expect(tagMessage).toContain("Preview URL:")
    // The preview URL should contain the deterministic alias for the branch
    expect(tagMessage).toMatch(/Preview URL:.*ci-release-2026-09-23-[a-f0-9]{8}.*aquilla-web-preview.*workers\.dev/)
  })
})
