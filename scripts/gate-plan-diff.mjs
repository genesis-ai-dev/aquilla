// The release-tooling gate (docs/RELEASE-RISK-GATES.md, "Gates"). The
// scripts that decide what ships (the planner, the cut, the deploy check)
// held every PR that touched them, with no gate. What a person checked
// before approving one was "does the line still do what it did", and for
// most of those PRs (a log line, a reason string, a refactor, a new report)
// the answer is a plain yes that a machine can give:
//
//   1. The base commit's own tests pass against the PR's scripts. The
//      workflow does this before it runs this file: it restores the base's
//      scripts/release-*.test.* over the PR's and runs them. A PR that had
//      to change an old test changed a pinned behaviour.
//   2. On today's real queue, the PR's scripts answer exactly as the base's
//      do: the same plan (which PRs are ready, which are held and why, the
//      branch name), the same deploy decision for the release in flight,
//      and, when the plan cuts, the same picks producing the same tree.
//
// Either difference is not a failure of the PR. It means the PR changes
// what ships or when, on purpose, and that is the case that goes to a
// person: the diff this prints is what they review.
//
// Usage: node scripts/gate-plan-diff.mjs <baseDir> <headDir>
//   GITHUB_TOKEN   read access, for the walk and gate lookups both sides make
// Both directories are checkouts of this repository with tags and release
// branches fetched. Run from the BASE checkout (risk-label.yml).
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** What of a plan decides a release: everything but the per-PR bookkeeping. */
export function planShape(plan) {
  return {
    cut: plan.cut,
    reason: plan.reason,
    branch: plan.branch ?? null,
    base: plan.base ?? null,
    ready: (plan.prs ?? []).map((pr) => `#${pr.number} walk=${pr.walk} areas=${(pr.areas ?? []).join(",")}`),
    held: (plan.held ?? []).map((pr) => `#${pr.number} ${pr.why}`),
  }
}

/** One line per field of two shapes that differs; lists are compared entry by entry. */
export function shapeDiff(label, base, head) {
  const lines = []
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    const a = base[key]
    const b = head[key]
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    if (Array.isArray(a) && Array.isArray(b)) {
      for (const entry of a.filter((item) => !b.includes(item))) lines.push(`${label}.${key}: only the base has \`${entry}\``)
      for (const entry of b.filter((item) => !a.includes(item))) lines.push(`${label}.${key}: only the PR has \`${entry}\``)
      if (!lines.some((line) => line.startsWith(`${label}.${key}:`))) lines.push(`${label}.${key}: same entries, different order`)
    } else {
      lines.push(`${label}.${key}: base ${JSON.stringify(a)}, PR ${JSON.stringify(b)}`)
    }
  }
  return lines
}

const run = (dir, script, args = []) => execFileSync("node", [path.join("scripts", script), ...args], { cwd: dir, encoding: "utf8", env: process.env, maxBuffer: 64 * 1024 * 1024 })

async function cutShape(dir, plan, label) {
  if (!plan.cut) return { picked: [], unpicked: [], recorded: [], tree: null }
  // Built in a scratch worktree: the cut checks out a branch, and neither
  // checkout this job compares may move under the scripts it is running.
  const scratch = mkdtempSync(path.join(tmpdir(), `plan-diff-${label}-`))
  execFileSync("git", ["worktree", "add", "--detach", "-f", scratch, plan.base], { cwd: dir, stdio: "ignore" })
  const { buildReleaseBranch } = await import(pathToFileURL(path.join(path.resolve(dir), "scripts", "release-cut.mjs")).href)
  const built = buildReleaseBranch({ branch: `gate/plan-diff-${label}`, base: plan.base, prs: plan.prs, held: plan.held ?? [], cwd: scratch })
  return {
    picked: built.picked.map((pr) => `#${pr.number}`),
    unpicked: built.unpicked.map((pr) => `#${pr.number} ${pr.why}`),
    recorded: (built.recorded ?? []).map((pr) => `#${pr.number}`),
    tree: execFileSync("git", ["rev-parse", `${built.sha}^{tree}`], { cwd: scratch, encoding: "utf8" }).trim(),
  }
}

async function main() {
  const [baseDir, headDir] = process.argv.slice(2)
  if (!baseDir || !headDir) {
    console.error("usage: gate-plan-diff.mjs <baseDir> <headDir>")
    process.exit(2)
  }
  // One clock for both sides: the branch name carries the date.
  const now = `--now=${new Date().toISOString()}`
  const basePlan = JSON.parse(run(baseDir, "release-plan.mjs", [now]))
  const headPlan = JSON.parse(run(headDir, "release-plan.mjs", [now]))
  const lines = shapeDiff("plan", planShape(basePlan), planShape(headPlan))
  lines.push(...shapeDiff("deploy", JSON.parse(run(baseDir, "release-deploy-check.mjs")), JSON.parse(run(headDir, "release-deploy-check.mjs"))))
  // Compared only when the plans agree: two different pick lists build two
  // different branches, and the plan lines above already say why.
  if (!lines.length) lines.push(...shapeDiff("cut", await cutShape(baseDir, basePlan, "base"), await cutShape(headDir, headPlan, "head")))
  for (const line of lines) console.log(`✗ ${line}`)
  if (!lines.length) console.log(`✓ plan diff: on today's queue (${basePlan.prCount} unreleased PRs) the PR's scripts plan, cut and decide the deploy exactly as the base's do`)
  process.exit(lines.length ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
