// Decides whether the release bot may cut a release slice from the unreleased
// PRs on origin/dev, and what to cut. Deterministic by design: the bot reads
// this JSON instead of judging these questions itself.
// Usage: node scripts/release-plan.mjs [--now=<iso>]   (run after `git fetch origin --tags`)
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export const BATCH_SIZE = 7
export const MAX_WAIT_HOURS = 24
export const HOLD_NUDGE_HOURS = 4

// A release branch is release/YYYY/MM/DD, optionally with a same-day -NN
// suffix for the Nth slice cut that date (NN starts at 01).
export function isReleaseBranch(name) {
  return /^release\/\d{4}\/\d{2}\/\d{2}(-\d{2})?$/.test(name)
}

// migration and infra paths hold the PR on their own: a schema change or a
// change to the deploy machinery itself needs a person, every time. sync and
// auth are only noted on the release notes so a person can see them; they do
// not hold by themselves — see the 2026-09-23 note in the release line plan.
const HOLDING_AREAS = new Set(["migration", "infra"])

const AREA_PATTERNS = [
  ["migration", /^db\/postgres\/(migrations\/|schema\.sql$)/],
  ["infra", /(^|\/)wrangler\.toml$|^config\/cloudflare-deployments\.json$|^scripts\/(cloudflare-|verify-deploy|resolve-deployment|tag-release)/],
  ["sync", /^(sync-worker\/src\/|src\/lib\/sync\/|db\/shim\/)/],
  ["auth", /^auth-worker\/src\//],
]

export function classifyFiles(files) {
  const areas = new Set()
  for (const file of files) {
    for (const [area, pattern] of AREA_PATTERNS) if (pattern.test(file)) areas.add(area)
  }
  const sorted = [...areas].sort()
  return { areas: sorted, pathHolds: sorted.some((area) => HOLDING_AREAS.has(area)) }
}

// FLAKY and BLOCKED both mean the bot could not prove the outcome, so the PR
// holds like a fail. `unknown` (no matching walk comment found yet) holds
// too: deploy stays off until the walk lookup fills it in.
export function prHolds(pr) {
  return pr.pathHolds || (pr.walk !== "PASS" && pr.walk !== "none")
}

// A PR whose diff touches only docs or only test/journey files has no UI
// claim, so the bot skips the walk entirely (PR-BOT.md) — there is no walk
// comment to look up, and there never will be one. This is a path check, not
// a GitHub lookup, so it needs no PAT and stays true even before the walk
// lookup script runs.
const DOCS_OR_TEST_FILE = /\.md$|^docs\/|\.test\.[jt]sx?$|^e2e\//

export function isDocsOrTestOnly(files) {
  return files.length > 0 && files.every((file) => DOCS_OR_TEST_FILE.test(file))
}

function branchName(now, usedSuffixes) {
  const d = new Date(now)
  const date = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`
  const used = new Set(usedSuffixes)
  let n = 1
  while (used.has(String(n).padStart(2, "0"))) n++
  return `release/${date}-${String(n).padStart(2, "0")}`
}

function cutSlice({ base, slice, reason, hold, now, usedSuffixesToday }) {
  return {
    ...base,
    cut: true,
    hold,
    reason,
    branch: branchName(now, usedSuffixesToday),
    sha: slice[slice.length - 1].sha,
    areas: [...new Set(slice.flatMap((pr) => pr.areas))].sort(),
    prs: slice.map(({ pathHolds, holds, ...pr }) => pr),
  }
}

// prs must already be sorted oldest merged first. Each PR needs number, sha,
// mergedAt, areas, and walk (see classifyFiles and the walk lookup).
export function planRelease({ openReleases, prs, now, latestTagAt = null, usedSuffixesToday = [] }) {
  const base = { openReleases, prCount: prs.length }
  if (openReleases.length) {
    return { ...base, cut: false, hold: false, reason: `release in flight: ${openReleases.join(", ")}`, prs: [] }
  }
  if (!prs.length) return { ...base, cut: false, hold: false, reason: "no unreleased PRs", prs: [] }

  const decorated = prs.map((pr) => ({ ...pr, holds: prHolds(pr) }))
  const oldest = decorated[0]

  // The oldest waiting PR itself holds: cut it alone, immediately. Everything
  // behind it has to wait for production order, so the human gate has to
  // appear at once, not after the ceiling or the 24-hour timer.
  if (oldest.holds) {
    return cutSlice({ base, slice: [oldest], reason: "oldest unreleased PR holds", hold: true, now, usedSuffixesToday })
  }

  const run = []
  for (const pr of decorated) {
    if (pr.holds) break
    run.push(pr)
    if (run.length >= BATCH_SIZE) break
  }

  // A holding PR sits right behind a non-empty run: ship the ready run now.
  // This slice cuts immediately — it does not wait on the ceiling, the
  // 24-hour timer, or draining, since those exist for a slice still filling
  // its queue, not one closed early by a hold behind it.
  const nextAfterRun = decorated[run.length]
  if (nextAfterRun?.holds) {
    return cutSlice({ base, slice: run, reason: `${run.length} ready PR(s), next PR holds`, hold: false, now, usedSuffixesToday })
  }

  if (run.length >= BATCH_SIZE) {
    return cutSlice({ base, slice: run, reason: `${run.length} unreleased PRs`, hold: false, now, usedSuffixesToday })
  }

  const oldestMergedAt = Date.parse(oldest.mergedAt)
  const waitedHours = (Date.parse(now) - oldestMergedAt) / 3_600_000
  if (waitedHours >= MAX_WAIT_HOURS) {
    return cutSlice({ base, slice: run, reason: `oldest unreleased PR waited ${Math.floor(waitedHours)}h`, hold: false, now, usedSuffixesToday })
  }

  // Draining: a production tag landed after the oldest unreleased PR merged.
  // The usual cause is the previous slice just deployed and the rest of the
  // queue should follow, without waiting out the ceiling or the timer again.
  if (latestTagAt && Date.parse(latestTagAt) > oldestMergedAt) {
    return cutSlice({ base, slice: run, reason: `draining, tagged ${latestTagAt}`, hold: false, now, usedSuffixesToday })
  }

  return { ...base, cut: false, hold: false, reason: `${run.length}/${BATCH_SIZE} PRs, oldest waited ${Math.floor(waitedHours)}h`, prs: [] }
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()
const lines = (text) => text.split("\n").filter(Boolean)

function releaseRefs() {
  return lines(git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/"))
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter(isReleaseBranch)
}

// A release branch is in flight until its HEAD carries a calver tag (deployed).
function openReleaseBranches() {
  return releaseRefs().filter((branch) => !lines(git("tag", "--points-at", `origin/${branch}`, "--list", "20*")).length)
}

function usedSuffixesToday(now) {
  const d = new Date(now)
  const prefix = `release/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`
  return releaseRefs()
    .filter((branch) => branch.startsWith(`${prefix}-`))
    .map((branch) => branch.slice(prefix.length + 1))
}

function latestTagAt() {
  const tags = lines(git("tag", "--list", "20*", "--sort=-creatordate", "--format=%(creatordate:iso-strict)"))
  return tags[0] ?? null
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
    // Anything with a UI claim needs the GitHub-API walk lookup (see
    // release-plan-walk.mjs) to fill in walk; the git-only command here
    // always leaves those unknown, which holds.
    const walk = isDocsOrTestOnly(files) ? "none" : "unknown"
    prs.push({ number: Number(number), sha, mergedAt, walk, ...classifyFiles(files) })
  }
  return prs.reverse()
}

async function main() {
  const nowArg = process.argv.find((arg) => arg.startsWith("--now="))
  const now = nowArg ? nowArg.slice(6) : new Date().toISOString()
  let prs = unreleasedPrs()
  // Without a token this stays the git-only command: every non-docs/test PR
  // reports walk: unknown, which holds, so cuts still happen but nothing
  // deploys itself until the lookup can run.
  const token = process.env.GITHUB_TOKEN
  if (token) {
    const { fillWalks } = await import("./release-plan-walk.mjs")
    prs = await fillWalks(prs, { token })
  }
  const plan = planRelease({
    openReleases: openReleaseBranches(),
    prs,
    now,
    latestTagAt: latestTagAt(),
    usedSuffixesToday: usedSuffixesToday(now),
  })
  console.log(JSON.stringify(plan, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
