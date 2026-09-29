import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { decideLiveRelease } from "./resolve-live-release.mjs"

const FULL = "13b603942aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const live = { sha: "13b6039", branch: "release/2026/09/28-03", builtAt: "2026-09-28T22:26:14.000Z" }

// The tag is the only record that a live build was verified, and an untagged
// release blocks the Deploy bot from cutting the next one. These rules decide
// whether CI may tag what production serves, so every refusal is spelled out.
describe("decideLiveRelease", () => {
  it("tags a live commit on its release branch that has no calver tag", () => {
    expect(decideLiveRelease({ version: live, fullSha: FULL, onBranch: true, tags: [] })).toMatchObject({
      action: "tag",
      sha: FULL,
      branch: "release/2026/09/28-03",
    })
  })

  it("skips a commit that already carries a tag, and names it", () => {
    const result = decideLiveRelease({ version: live, fullSha: FULL, onBranch: true, tags: ["2026.09.28.02"] })
    expect(result.action).toBe("skip")
    expect(result.reason).toContain("2026.09.28.02")
  })

  it("accepts a plain-date release branch with no -NN suffix", () => {
    const version = { ...live, branch: "release/2026/09/24" }
    expect(decideLiveRelease({ version, fullSha: FULL, onBranch: true, tags: [] }).action).toBe("tag")
  })

  it.each([
    ["dev", "not a release/YYYY/MM/DD[-NN] branch"],
    ["main", "not a release/YYYY/MM/DD[-NN] branch"],
    ["release/2026/09/28-03; rm -rf /", "not a release/YYYY/MM/DD[-NN] branch"],
    ["", "not a release/YYYY/MM/DD[-NN] branch"],
  ])("refuses to tag a build from branch %j", (branch, reason) => {
    const result = decideLiveRelease({ version: { ...live, branch }, fullSha: FULL, onBranch: true, tags: [] })
    expect(result.action).toBe("error")
    expect(result.reason).toContain(reason)
  })

  it.each([undefined, null, "not json", {}, { sha: "" }, { sha: "zzzzzzz", branch: live.branch }, { sha: "abc12", branch: live.branch }])(
    "refuses a version.json without a usable sha: %j",
    (version) => {
      expect(decideLiveRelease({ version, fullSha: FULL, onBranch: true, tags: [] }).action).toBe("error")
    },
  )

  it("refuses when the live commit is not on origin", () => {
    const result = decideLiveRelease({ version: live, fullSha: "", onBranch: false, tags: [] })
    expect(result).toEqual({ action: "error", reason: "Live commit 13b6039 is not on origin." })
  })

  it("refuses when the live commit is not on the branch version.json names", () => {
    const result = decideLiveRelease({ version: live, fullSha: FULL, onBranch: false, tags: [] })
    expect(result).toEqual({ action: "error", reason: "Live commit 13b6039 is not on origin/release/2026/09/28-03." })
  })
})

// A path with a space or a symlink made the old entrypoint check skip main()
// and exit 0 having done nothing (see 6d4d048f2). Copy the script somewhere
// awkward and run it against an unreachable URL: it must fail loudly.
describe("resolve-live-release.mjs entrypoint", () => {
  it("runs main() from a folder with a space in its name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "resolve live release "))
    try {
      mkdirSync(path.join(dir, "a b"))
      const copy = path.join(dir, "a b", "resolve-live-release.mjs")
      copyFileSync(path.join(import.meta.dirname, "resolve-live-release.mjs"), copy)
      const result = spawnSync("node", [copy], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, LIVE_VERSION_URL: "http://127.0.0.1:9/version.json" },
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("ABORT:")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
