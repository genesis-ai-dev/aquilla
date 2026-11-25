// The dependency gate (docs/RELEASE-RISK-GATES.md, "Gates"). A worker's
// package.json and lockfile used to hold as gate machinery, with no gate:
// the other gates run through those packages, so a PR that changes them
// could in principle make its own gate pass. In practice almost every such
// PR is a version bump, and what a person checked before approving one was
// three things this script reads off the two checkouts:
//
//   1. Nothing but versions moved. Every changed field of package.json is an
//      entry of a dependency map, and its value is a plain registry range:
//      no `npm:` alias, no git, file or workspace source, no script, no
//      override. A new or removed dependency is a version change too.
//   2. The test engine did not move. The packages the gates execute through
//      (ENGINE) resolve, in the lockfile, to the versions the base resolves
//      them to. A PR that changes what runs the gate goes to a person.
//   3. The gates still answer their goldens on the new set: the workflow
//      runs the replay corpus and the permission matrix after this script.
//
// Usage: node scripts/gate-deps.mjs <baseDir> <headDir>
// Run from the BASE checkout (risk-label.yml), so a PR cannot edit the
// checker that checks it.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const WORKERS = ["sync-worker", "auth-worker"]
/** What the replay gate and the auth matrix execute through. */
export const ENGINE = ["vitest", "@electric-sql/pglite"]
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "optionalDependencies"]
// 1.2.3, ^1.2.3, ~1.2.3, with an optional prerelease or build tag.
const REGISTRY_RANGE = /^[~^]?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/** Problems with how `head`'s package.json differs from `base`'s; empty when only versions moved. */
export function manifestProblems(base, head) {
  const problems = []
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (JSON.stringify(base[key]) === JSON.stringify(head[key])) continue
    if (!DEPENDENCY_MAPS.includes(key)) {
      problems.push(`\`${key}\` changed; only dependency versions may`)
      continue
    }
    const before = base[key] ?? {}
    const after = head[key] ?? {}
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[name] === after[name]) continue
      if (ENGINE.includes(name)) problems.push(`${key}.${name} changed (${before[name] ?? "absent"} → ${after[name] ?? "absent"}); the gates run through it`)
      else if (after[name] !== undefined && !REGISTRY_RANGE.test(after[name])) problems.push(`${key}.${name} is \`${after[name]}\`, not a plain registry version`)
    }
  }
  return problems
}

/** The version the lockfile resolves a direct dependency of the importer to, or undefined. */
export function lockedVersion(lockfile, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const match = new RegExp(`^ {6}'?${escaped}'?:\\n {8}specifier: .*\\n {8}version: (.+)$`, "m").exec(lockfile)
  return match?.[1].trim()
}

export function engineProblems(baseLock, headLock) {
  const problems = []
  for (const name of ENGINE) {
    const before = lockedVersion(baseLock, name)
    const after = lockedVersion(headLock, name)
    if (!before || !after) problems.push(`cannot read the locked version of ${name}; not deciding without it`)
    else if (before !== after) problems.push(`${name} resolves to ${after}, the base to ${before}; the gates run through it`)
  }
  return problems
}

export function checkWorker(baseDir, headDir, worker) {
  const read = (root, file) => readFileSync(path.join(root, worker, file), "utf8")
  const present = (root, file) => existsSync(path.join(root, worker, file))
  if (!present(baseDir, "package.json") || !present(headDir, "package.json")) return [`${worker}/package.json is missing on one side`]
  return [
    ...manifestProblems(JSON.parse(read(baseDir, "package.json")), JSON.parse(read(headDir, "package.json"))),
    ...engineProblems(read(baseDir, "pnpm-lock.yaml"), read(headDir, "pnpm-lock.yaml")),
  ].map((problem) => `${worker}: ${problem}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baseDir, headDir] = process.argv.slice(2)
  if (!baseDir || !headDir) {
    console.error("usage: gate-deps.mjs <baseDir> <headDir>")
    process.exit(2)
  }
  const problems = WORKERS.flatMap((worker) => checkWorker(baseDir, headDir, worker))
  for (const problem of problems) console.log(`✗ ${problem}`)
  if (!problems.length) console.log("✓ deps gate: only dependency versions changed, and the test engine did not")
  process.exit(problems.length ? 1 : 0)
}
