// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"

// Use native process/path; the SPA Vite config supplies browser polyfills.
const require = createRequire(import.meta.url)
const process = require("node:process") as typeof import("node:process")
const path = require("node:path") as typeof import("node:path")

const root = process.cwd()
const fixtures: string[] = []
afterEach(() => fixtures.splice(0).forEach((dir) => rmSync(dir, {
  recursive: true, force: true,
})))

// Exercise the real hook with stubbed leaf commands and Git's inherited
// repository variables. Verify command selection and shell failure semantics.
function push(failCommand = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "aquilla-push-test-"))
  fixtures.push(dir)
  const log = path.join(dir, "commands.jsonl")
  const pnpm = path.join(dir, "pnpm")
  writeFileSync(pnpm, `#!${process.execPath}
const { appendFileSync } = require("node:fs")
const args = process.argv.slice(2)
const command = args.join(" ")
appendFileSync(process.env.PUSH_TEST_LOG, JSON.stringify({
  command, refs: process.env.E2E_PUSH_REFS,
  gitDir: process.env.GIT_DIR, gitWorkTree: process.env.GIT_WORK_TREE,
  gitIndex: process.env.GIT_INDEX_FILE,
}) + "\\n")
if (command === process.env.PUSH_TEST_FAIL) process.exit(17)
`)
  chmodSync(pnpm, 0o755)
  const env = { ...process.env }
  delete env.WORKERS_CI
  delete env.WORKERS_CI_BRANCH
  delete env.WORKERS_CI_COMMIT_SHA
  const result = spawnSync("/bin/sh", [".husky/pre-push"], {
    cwd: root,
    env: {
      ...env, PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      PUSH_TEST_LOG: log, PUSH_TEST_FAIL: failCommand,
      GIT_DIR: path.join(root, ".git"), GIT_WORK_TREE: root,
      GIT_INDEX_FILE: path.join(dir, "caller-index"),
    },
    input: "refs/heads/feature abc refs/heads/feature def\n",
    encoding: "utf8", timeout: 30_000,
  })
  if (result.error) throw result.error
  const entries = readFileSync(log, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { command: string; refs: string; gitDir?: string; gitWorkTree?: string; gitIndex?: string })
  return { result, entries, commands: entries.map(({ command }) => command) }
}

describe("pre-push validation", () => {
  it("runs only the secret scan and affected E2E with clean Git variables", () => {
    const { result, entries, commands } = push()
    expect(result.status, result.stderr).toBe(0)
    expect(entries.every(({ gitDir, gitWorkTree, gitIndex }) =>
      gitDir === undefined && gitWorkTree === undefined && gitIndex === undefined,
    )).toBe(true)
    expect(commands).toEqual(["run scan:secrets", "run test:e2e:affected"])
    expect(entries.at(-1)?.refs).toBe("refs/heads/feature abc refs/heads/feature def")
    expect(commands.join("\n")).not.toMatch(/build:workers-build|deploy:/)
  })

  it("blocks tests and the push when credential scanning fails", () => {
    const { result, commands } = push("run scan:secrets")
    expect(result.status).toBe(17)
    expect(commands).toEqual(["run scan:secrets"])
  })

  it("preserves a failing affected E2E exit status", () => {
    expect(push("run test:e2e:affected").result.status).toBe(17)
  })
})
