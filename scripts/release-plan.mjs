// Decides whether the release bot may cut release/YYYY/MM/DD from origin/dev,
// and lists the unreleased PRs with a path-based risk tier. Deterministic by
// design: the bot reads this JSON instead of judging these questions itself.
// Usage: node scripts/release-plan.mjs [--now=<iso>]   (run after `git fetch origin --tags`)
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export const BATCH_SIZE = 4
export const MAX_WAIT_HOURS = 24

// A release branch is release/YYYY/MM/DD, optionally with a same-day -NN suffix
// for the Nth slice cut that date (NN starts at 01).
export function isReleaseBranch(name) {
  return /^release\/\d{4}\/\d{2}\/\d{2}(-\d{2})?$/.test(name)
}

const HIGH_RISK = [
  ["migration", /^db\/postgres\/(migrations|schema\.sql)/],
  ["sync", /^(sync-worker\/src\/|src\/lib\/sync\/|db\/shim\/)/],
  ["auth", /^auth-worker\/src\//],
  ["infra", /(^|\/)wrangler\.toml$|^config\/cloudflare-deployments\.json$|^scripts\/(cloudflare-|verify-deploy|resolve-deployment|tag-release)/],
]

export function classifyFiles(files) {
  const areas = new Set()
  for (const file of files) {
    for (const [area, pattern] of HIGH_RISK) if (pattern.test(file)) areas.add(area)
  }
  return { tier: areas.size ? "high" : "low", areas: [...areas].sort() }
}

export function planRelease({ openReleases, prs, now }) {
  const tier = prs.some((pr) => pr.tier === "high") ? "high" : "low"
  const base = { openReleases, prCount: prs.length, tier, prs }
  if (openReleases.length) {
    return { ...base, cut: false, reason: `release in flight: ${openReleases.join(", ")}` }
  }
  if (!prs.length) return { ...base, cut: false, reason: "no unreleased PRs" }
  if (prs.length >= BATCH_SIZE) return { ...base, cut: true, reason: `${prs.length} unreleased PRs` }
  const oldest = Math.min(...prs.map((pr) => Date.parse(pr.mergedAt)))
  const waited = (Date.parse(now) - oldest) / 3_600_000
  if (waited >= MAX_WAIT_HOURS) {
    return { ...base, cut: true, reason: `oldest unreleased PR waited ${Math.floor(waited)}h` }
  }
  return { ...base, cut: false, reason: `${prs.length}/${BATCH_SIZE} PRs, oldest waited ${Math.floor(waited)}h` }
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()
const lines = (text) => text.split("\n").filter(Boolean)

// A release branch is in flight until its HEAD carries a calver tag (deployed).
function openReleaseBranches() {
  return lines(git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/"))
    .filter((ref) => /^origin\/release\/\d{4}\/\d{2}\/\d{2}$/.test(ref))
    .filter((ref) => !lines(git("tag", "--points-at", ref, "--list", "20*")).length)
    .map((ref) => ref.replace(/^origin\//, ""))
}

function unreleasedPrs() {
  const tags = lines(git("tag", "--list", "20*", "--sort=-v:refname"))
  // Before the first calver tag, origin/main is what production runs.
  const range = `${tags[0] ?? "origin/main"}..origin/dev`
  const log = lines(git("log", "--first-parent", "--format=%H%x09%cI%x09%s", range))
  const prs = []
  for (const entry of log) {
    const [sha, mergedAt, subject] = entry.split("\t")
    const number = subject.match(/^Merge pull request #(\d+)/)?.[1] ?? subject.match(/\(#(\d+)\)$/)?.[1]
    if (!number) continue
    const parent = subject.startsWith("Merge pull request") ? `${sha}^1` : `${sha}^`
    const files = lines(git("diff", "--name-only", parent, sha))
    prs.push({ number: Number(number), sha, mergedAt, ...classifyFiles(files) })
  }
  return prs.reverse()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nowArg = process.argv.find((arg) => arg.startsWith("--now="))
  const now = nowArg ? nowArg.slice(6) : new Date().toISOString()
  console.log(JSON.stringify(planRelease({ openReleases: openReleaseBranches(), prs: unreleasedPrs(), now }), null, 2))
}
