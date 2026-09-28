import { execFileSync, spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Explicit local invocation for a reviewed checkout. This is not a webhook
// executor: do not connect arbitrary PR code to a secret-bearing CI machine.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2).filter((arg) => arg !== "--")
const pr = Number(args[0])
if (args.length !== 1 || !Number.isSafeInteger(pr) || pr <= 0) {
  throw new Error("Usage: pnpm test:smart:pr -- <PR number>")
}
const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" }).trim()
if (git("status", "--porcelain")) throw new Error("Commit changes before reporting a PR run")
const sha = git("rev-parse", "HEAD")
const pull = JSON.parse(execFileSync("gh", ["api", `repos/genesis-ai-dev/aquilla/pulls/${pr}`], { encoding: "utf8" }))
if (pull.state !== "open" || pull.head?.sha !== sha || pull.head?.repo?.full_name !== "genesis-ai-dev/aquilla") {
  throw new Error("Checkout must match the exact open, same-repository PR head")
}
const id = `pr-${pr}-${Date.now()}`
const report = (phase, evidencePath) => spawnSync(process.execPath, [
  "scripts/smart-test-comment.mjs", phase, String(pr), sha, ...(evidencePath ? [evidencePath] : []),
], { cwd: root, stdio: "inherit", env: process.env })
const started = report("running")
if (started.status !== 0) throw new Error("Could not publish the starting report")
const env = { ...process.env, SMART_TEST_RUN_ID: id }
delete env.GITHUB_TOKEN
delete env.GH_TOKEN
const result = spawnSync("pnpm", ["test:smart"], { cwd: root, stdio: "inherit", env })
const finished = report("finished", path.join(root, "smart-tests/results", id, "suite.json"))
process.exitCode = result.status === 0 && finished.status === 0 ? 0 : 1
