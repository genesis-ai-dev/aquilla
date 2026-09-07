// Publish the staged public tree into the public mirror repo as a fresh commit.
// This is the ONE irreversible step — it is gated behind --confirm and re-runs
// the safety gate first. Default (no --confirm) is a dry run that only prints
// what it would do.
//
//   # dry run (prints plan, changes nothing):
//   pnpm tsx scripts/public-release/publish.ts --staging .public-build --public /path/to/public-clone
//   # actually commit + push:
//   pnpm tsx scripts/public-release/publish.ts --staging .public-build --public /path/to/public-clone --confirm --push
//
// The public mirror is a SEPARATE git repo (clone of the public GitHub repo).
// Each run replaces its working tree with the scrubbed snapshot and commits —
// private history never crosses over. Run on a schedule against `main`.

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback
}
const has = (name: string) => process.argv.includes(`--${name}`)

const staging = path.resolve(arg("staging", ".public-build")!)
const publicRepo = arg("public")
const confirm = has("confirm")
const push = has("push")
const sourceSha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()

function sh(cmd: string, args: string[], cwd?: string) {
  return execFileSync(cmd, args, { cwd, stdio: "pipe" }).toString().trim()
}

if (!publicRepo) {
  console.error("✗ --public <path to public mirror clone> is required")
  process.exit(1)
}
if (!fs.existsSync(staging)) {
  console.error(`✗ staging dir ${staging} not found — run build-public-tree.ts first`)
  process.exit(1)
}
if (!fs.existsSync(path.join(publicRepo, ".git"))) {
  console.error(`✗ ${publicRepo} is not a git repo. Create the public mirror first:`)
  console.error(`    git init ${publicRepo} && (cd ${publicRepo} && git remote add origin <public-url>)`)
  process.exit(1)
}

// Re-run the safety gate against the staging tree — never publish unverified.
console.log("Running safety gate…")
try {
  execFileSync("pnpm", ["tsx", "scripts/public-release/verify-public-tree.ts", "--dir", staging], { stdio: "inherit" })
} catch {
  console.error("✗ safety gate failed — publish aborted.")
  process.exit(1)
}

const plan = [
  `source:   ${sourceSha} (private main)`,
  `staging:  ${staging}`,
  `mirror:   ${publicRepo}`,
  `action:   rsync --delete staging → mirror, git add -A, commit${push ? ", push" : " (no push)"}`,
]
console.log("\nPublish plan:\n  " + plan.join("\n  "))

if (!confirm) {
  console.log("\n(dry run — pass --confirm to apply. Publishing is irreversible.)")
  process.exit(0)
}

// Replace mirror working tree with the scrubbed snapshot (preserve its .git).
sh("rsync", ["-a", "--delete", "--exclude", ".git", staging + "/", publicRepo + "/"])
sh("git", ["add", "-A"], publicRepo)
const status = sh("git", ["status", "--porcelain"], publicRepo)
if (!status) {
  console.log("\n✓ mirror already up to date — nothing to commit.")
  process.exit(0)
}
sh("git", ["commit", "-m", `sync from private main @ ${sourceSha}`], publicRepo)
console.log(`\n✓ committed snapshot @ ${sourceSha} to mirror`)
if (push) {
  sh("git", ["push", "origin", "HEAD"], publicRepo)
  console.log("✓ pushed to public remote")
} else {
  console.log("(skipped push — pass --push to publish to the public remote)")
}
