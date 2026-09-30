// Decides whether the release bot may cut a release slice from the unreleased
// PRs on origin/dev, and what to cut. Deterministic by design: the bot reads
// this JSON instead of judging these questions itself.
// Usage: node scripts/release-plan.mjs [--now=<iso>]   (run after `git fetch origin --tags`)
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

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

// "verify-" catches every verify-*.{sh,mjs} script (verify-deploy-branch,
// verify-dist-host, verify-deployment-artifacts, verify-live-environment,
// verify-worker-deployment) — all of them run unattended during
// `deploy:aquilla*` or are imported by scripts/cloudflare-version-deploy.mjs,
// which does. tag-metadata and record-github-deployment run from
// tag-release.sh right before the tag push; assert-workers-build-env and
// ci-build are what Cloudflare's own build trigger runs for every branch,
// including the production one.
const AREA_PATTERNS = [
  ["migration", /^db\/postgres\/(migrations\/|schema\.sql$)/],
  ["infra", /(^|\/)wrangler\.toml$|^config\/cloudflare-deployments\.json$|^scripts\/(cloudflare-|verify-|resolve-deployment|tag-release|tag-metadata|record-github-deployment|assert-workers-build-env|ci-build)/],
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

// A PR whose diff touches only docs, only test/journey files, or only
// allowlisted tooling scripts has no UI claim, so the bot skips the walk
// entirely (PR-BOT.md). There is no walk comment to look up, and there never
// will be one. This is a path check, not a GitHub lookup, so it needs no PAT
// and stays true even before the walk lookup script runs.
//
// Scripts are allowlisted, not all of scripts/: vite.config.ts imports
// scripts/vite-html-branding.ts and scripts/build-info.ts, so a change there
// ships in the app and needs a walk. A new script needs a walk until someone
// checks that nothing in the app or worker builds imports it and adds it
// here. Infra scripts (cloudflare-*, verify-*, tag-release, ...) hold on
// their own through classifyFiles/pathHolds, whatever this says.
const NO_UI_SCRIPT = /^scripts\/(release-plan|qa\/|smart-test|e2e-)/
const DOCS_OR_TEST_FILE = /\.md$|^docs\/|\.test\.[jt]sx?$|^e2e\//

export function isDocsOrTestOnly(files) {
  return files.length > 0 && files.every((file) => DOCS_OR_TEST_FILE.test(file) || NO_UI_SCRIPT.test(file))
}

function branchName(now, usedSuffixes) {
  const d = new Date(now)
  const date = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`
  const used = new Set(usedSuffixes)
  let n = 1
  while (used.has(String(n).padStart(2, "0"))) n++
  return `release/${date}-${String(n).padStart(2, "0")}`
}

function cutSlice({ base, slice, reason, hold, now, usedSuffixesToday, floor }) {
  const tail = slice[slice.length - 1]
  return {
    ...base,
    cut: true,
    hold,
    reason,
    branch: branchName(now, usedSuffixesToday),
    // A slice that ends behind the floor cuts at the floor instead: the
    // branch then carries what production already runs plus this slice,
    // never less (see splitReleased).
    sha: floor && tail.behindFloor ? floor : tail.sha,
    areas: [...new Set(slice.flatMap((pr) => pr.areas))].sort(),
    prs: slice.map(({ pathHolds, holds, behindFloor, ...pr }) => pr),
  }
}

// prs must already be sorted oldest merged first. Each PR needs number, sha,
// mergedAt, areas, and walk (see classifyFiles and the walk lookup).
//
// One release is in flight at a time. The moment it closes (tagged or
// deleted), the next slice cuts immediately at whatever's ready in dev —
// there's no ceiling and no wait timer. Waiting for a ceiling or a clock
// only means a hotfix cherry-picked onto the closed branch has to be
// re-cherry-picked onto every slice cut before dev catches up; cutting at
// dev's current head the instant the line is free means dev already carries
// the fix, so the next slice just picks it up.
//
// floor is the newest dev commit production already runs (see splitReleased);
// no slice cuts below it. PRs marked behindFloor sit before it on dev, so the
// smallest cut that ships any of them is at the floor, which ships all of
// them: they are one indivisible head of the queue.
export function planRelease({ openReleases, prs, now, usedSuffixesToday = [], floor }) {
  const base = { openReleases, prCount: prs.length, floor }
  if (openReleases.length) {
    return { ...base, cut: false, hold: false, reason: `release in flight: ${openReleases.join(", ")}`, prs: [] }
  }
  if (!prs.length) return { ...base, cut: false, hold: false, reason: "no unreleased PRs", prs: [] }

  const decorated = prs.map((pr) => ({ ...pr, holds: prHolds(pr) }))
  let behind = 0
  while (behind < decorated.length && decorated[behind].behindFloor) behind++
  const head = decorated.slice(0, Math.max(behind, 1))

  // The head of the queue holds: cut it alone, immediately. Everything
  // behind it has to wait for production order, so the human gate has to
  // appear at once.
  if (head.some((pr) => pr.holds)) {
    const reason = head.length > 1 ? "a PR behind the deployed floor holds" : "oldest unreleased PR holds"
    return cutSlice({ base, slice: head, reason, hold: true, now, usedSuffixesToday, floor })
  }

  const run = []
  for (const pr of decorated) {
    if (pr.holds) break
    run.push(pr)
  }

  return cutSlice({ base, slice: run, reason: `${run.length} ready PR(s), no release in flight`, hold: false, now, usedSuffixesToday, floor })
}

// Which PR a first-parent commit stands for: GitHub's merge subject, or the
// "(#N)" suffix of a squash merge. Undefined for anything else.
export function prNumberFromSubject(subject) {
  const number = subject.match(/^Merge pull request #(\d+)/)?.[1] ?? subject.match(/\(#(\d+)\)$/)?.[1]
  return number === undefined ? undefined : Number(number)
}

// What a tagged release tip proves it carries from dev. A release branch is
// built by `git cherry-pick -x -m 1 <dev merge sha>` (DEPLOYMENT-ENVIRONMENTS
// "Cutting a release"; release/2026/09/28-04 is the shape), so the calver tag
// sits on a pick, not on dev's first-parent line, and `<tag>..origin/dev`
// never shrinks on its own. Each pick keeps the dev merge's subject and adds
// a "(cherry picked from commit <sha>)" line to its body. That line is not a
// `key: value` trailer, so `%(trailers)` never sees it: read %b. A pick made
// without -x still carries the "Merge pull request #N" subject, so the PR
// number is the second, weaker key.
export function releasedMarks(tagEntries) {
  const shas = new Set()
  const numbers = new Set()
  for (const { subject, body } of tagEntries) {
    for (const [, sha] of body.matchAll(/\(cherry picked from commit ([0-9a-f]{40})\)/g)) shas.add(sha)
    const number = prNumberFromSubject(subject)
    if (number !== undefined) numbers.add(number)
  }
  return { shas, numbers }
}

// Splits dev's first-parent commits above the cut point (oldest first) into
// the ones the tagged tip already carries and the ones still waiting.
//
// floor is the newest dev commit production already runs: the cut point when
// nothing above it was picked, otherwise the newest picked commit. A hotfix
// picked ahead of its dev order (2026.09.28.03 carried #912 while 28 older
// dev PRs waited, #776's migration among them) puts the floor above PRs that
// are still unreleased; those come back marked behindFloor. The range starts
// at the cut point, not the floor, because a range starting at the floor
// would drop those PRs from the plan and ship them without their hold.
export function splitReleased({ devEntries, marks, cutPoint }) {
  const released = (entry) => marks.shas.has(entry.sha) || marks.numbers.has(prNumberFromSubject(entry.subject))
  let floorIndex = -1
  devEntries.forEach((entry, index) => {
    if (released(entry)) floorIndex = index
  })
  const floor = floorIndex === -1 ? cutPoint : devEntries[floorIndex].sha
  const unreleased = []
  devEntries.forEach((entry, index) => {
    if (!released(entry)) unreleased.push({ ...entry, behindFloor: index < floorIndex })
  })
  return { unreleased, floor }
}

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", ...opts }).trim()
const lines = (text) => text.split("\n").filter(Boolean)

function releaseRefs() {
  return lines(git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/"]))
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter(isReleaseBranch)
}

// A release branch is in flight until its HEAD carries a calver tag (deployed).
function openReleaseBranches() {
  return releaseRefs().filter((branch) => !lines(git(["tag", "--points-at", `origin/${branch}`, "--list", "20*"])).length)
}

function usedSuffixesToday(now) {
  const d = new Date(now)
  const prefix = `release/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`
  return releaseRefs()
    .filter((branch) => branch.startsWith(`${prefix}-`))
    .map((branch) => branch.slice(prefix.length + 1))
}

// One record per first-parent commit in range, newest first, body included:
// the pick provenance releasedMarks reads lives in %b.
function logEntries(range, cwd) {
  const raw = git(["log", "--first-parent", "--format=%H%x1f%cI%x1f%s%x1f%b%x1e", range], { cwd })
  return raw.split("\x1e").map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, mergedAt, subject, body = ""] = record.split("\x1f")
    return { sha, mergedAt, subject, body }
  })
}

// Every PR merged to dev that production does not run yet, oldest first, and
// the floor no slice may cut below. cwd is for tests driving a scratch repo.
export function unreleasedPrs({ cwd } = {}) {
  const tags = lines(git(["tag", "--list", "20*", "--sort=-v:refname"], { cwd }))
  // Before the first calver tag, origin/main is what production runs.
  const released = tags[0] ?? "origin/main"
  // The tagged tip is normally a pick off dev; the cut point is the newest
  // dev commit it holds by ancestry. A tag on dev is its own cut point, and
  // then nothing is off dev to read marks from: today's `<tag>..origin/dev`.
  const cutPoint = git(["merge-base", released, "origin/dev"], { cwd })
  const marks = releasedMarks(logEntries(`origin/dev..${released}`, cwd))
  const devEntries = logEntries(`${cutPoint}..origin/dev`, cwd).reverse()
  const { unreleased, floor } = splitReleased({ devEntries, marks, cutPoint })
  const prs = []
  for (const { sha, mergedAt, subject, behindFloor } of unreleased) {
    const number = prNumberFromSubject(subject)
    if (number === undefined) continue
    const parent = subject.startsWith("Merge pull request") ? `${sha}^1` : `${sha}^`
    const files = lines(git(["diff", "--name-only", parent, sha], { cwd }))
    // Anything with a UI claim needs the GitHub-API walk lookup (see
    // release-plan-walk.mjs) to fill in walk; the git-only command here
    // always leaves those unknown, which holds.
    const walk = isDocsOrTestOnly(files) ? "none" : "unknown"
    prs.push({ number, sha, mergedAt, walk, behindFloor, ...classifyFiles(files) })
  }
  return { prs, floor }
}

async function main() {
  const nowArg = process.argv.find((arg) => arg.startsWith("--now="))
  const now = nowArg ? nowArg.slice(6) : new Date().toISOString()
  const unreleased = unreleasedPrs()
  let { prs } = unreleased
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
    usedSuffixesToday: usedSuffixesToday(now),
    floor: unreleased.floor,
  })
  console.log(JSON.stringify(plan, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
