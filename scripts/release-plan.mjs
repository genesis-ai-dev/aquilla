// Decides whether the Release cut workflow may cut a release slice from the
// unreleased PRs on origin/dev, and what to cut. Deterministic by design: the
// workflow acts on this JSON and judges nothing itself.
//
// A commit pushed straight to dev with no PR is planned too, in its dev
// position (docs/decisions/0014-direct-dev-commits-on-the-release-line.md):
// picked when it only touches generated locale catalogs, held as "not a PR"
// otherwise. One that changes a file is never left out of the plan.
// Usage: node scripts/release-plan.mjs [--now=<iso>]   (run after `git fetch origin --tags`)
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

export const HOLD_NUDGE_HOURS = 4

// A release branch is release/YYYY/MM/DD, optionally with a same-day -NN
// suffix for the Nth slice cut that date (NN starts at 01).
export function isReleaseBranch(name) {
  return /^release\/\d{4}\/\d{2}\/\d{2}(-\d{2})?$/.test(name)
}

// Which outcomes a PR's files could cause, and whether that keeps it off
// the automatic line, is decided in release-risk.mjs (the labeler reads the
// same table). Re-exported so the plan's consumers have one import.
import { classifyFiles, holdingAreas } from "./release-risk.mjs"

export { classifyFiles }

// What a walk has to say for a PR to ride the line (WALK_POLICY, a repository
// variable release-cut.yml passes through):
//
//   fail-only (default, 2026-11-19)  only a walk that tried and could not
//       prove the claim holds: FAIL, FLAKY, BLOCKED (all read as `fail`).
//       A PR nobody walked (`unknown`) and a PASS at test level only
//       (`partial`) ship.
//   strict    the rule until 2026-11-19: anything but PASS or `none` holds.
//
// Why the default moved. "Nobody saw it in a browser" is not one of the
// outcomes that cannot be fixed forward (RELEASE-RISK-GATES.md §1), and for
// two weeks it was the hold on three PRs in four: 36 of the 47 PRs waiting
// on 2026-11-19 had no walk or a test-level one, against 6 held by a risk
// area. The walks were missing for reasons unrelated to the changes (a
// comment format the planner could not read, then previews the walker could
// not sign in to), so the hold measured the walker, and people cleared it by
// labelling every PR `release:approved` in batches. What stands behind an
// unwalked PR now is the release slice's own full suite and smart Jev, and
// the rollback watch after the deploy (release-rollback.mjs). `strict` is
// the switch back, with no code change.
export const WALK_POLICIES = ["fail-only", "strict"]
export const DEFAULT_WALK_POLICY = "fail-only"

export function walkPolicy(env = process.env) {
  return WALK_POLICIES.includes(env.WALK_POLICY) ? env.WALK_POLICY : DEFAULT_WALK_POLICY
}

/** Whether this walk verdict keeps a PR off the line under `policy`. */
export function walkHolds(walk, policy = DEFAULT_WALK_POLICY) {
  if (walk === "PASS" || walk === "none") return false
  return policy === "strict" ? true : walk !== "unknown" && walk !== "partial"
}

// A PR is off the automatic line when a holding area it touches has no
// green gate (release-risk.mjs AREA_GATES; `gates` is the list of areas
// whose gate check passed on the PR's head, from release-plan-walk.mjs),
// or its walk holds under the policy above. The `release:approved` label is
// a person's sign-off after the manual QA path, and clears both: once a
// person has signed, the line picks the PR like any other.
//
// A direct commit (`direct: true`, no PR number) has no walk, no gate run
// and no PR to carry the label, so none of that is read for it: it is ready
// only when every file it touches is a generated locale catalog, and held
// otherwise until a person picks it onto a release branch by hand.
export function prHolds(pr, policy = DEFAULT_WALK_POLICY) {
  if (pr.direct) return !isLocaleCatalogOnly(pr.files ?? [])
  if (pr.approved) return false
  return holdingAreas(pr.areas ?? [], pr.gates).length > 0 || walkHolds(pr.walk, policy)
}

// The reason a held direct commit carries. release-cut.mjs keys the notes'
// "pick it by hand" sentence on it.
export const NOT_A_PR = "not a PR"

// Why a held PR is held, for the release notes and the PR comment. A direct
// commit is held for not being a PR whatever it touches; its holding areas
// ride along so the person picking it by hand sees them.
export function holdReason(pr) {
  const areas = holdingAreas(pr.areas ?? [], pr.gates)
  if (pr.direct) return areas.length ? `${NOT_A_PR}; touches ${areas.join(", ")}` : NOT_A_PR
  if (areas.length) return `touches ${areas.join(", ")}`
  return `walk ${pr.walk}`
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

// The generated locale catalogs: one module per non-English locale, written
// by `scripts/i18n-catalog.ts import`, and the source-hash sidecar it keeps
// beside them. A direct commit touching nothing else is the daily
// localization push, which appends keys to every catalog; the release line
// has to carry it in dev order, or the next PR that appends locale keys
// conflicts in the sidecar (2026-11-20: #2075 and #2124, behind six such
// commits). Same idea as isDocsOrTestOnly: a path check, no walk to wait for.
//
// en.ts (the English source barrel), index.ts and all.ts (the registries a
// new locale edits) are code, not catalogs, and so are the tests beside them.
//
// The import also prunes translation-baseline.json (AQU-2740: the keys each
// locale may still show in English), so that file is part of the same push.
const LOCALE_CATALOG_FILE = /^src\/lib\/i18n\/(source-hashes\.json$|translation-baseline\.json$|messages\/(?!(?:en|index|all)\.ts$)[A-Za-z-]+\.ts$)/

export function isLocaleCatalogOnly(files) {
  return files.length > 0 && files.every((file) => LOCALE_CATALOG_FILE.test(file))
}

// How a planned entry is named to a person: `#N` for a PR, the short dev sha
// for a direct commit, which has no number.
export function entryLabel(entry) {
  return entry.direct ? String(entry.sha).slice(0, 9) : `#${entry.number}`
}

// "3 PR(s)", or "3 PR(s) and 1 direct commit(s)" once the list carries any.
// `adjective` goes before "PR(s)": tally(ready, "ready") is "3 ready PR(s)".
export function tally(entries, adjective = "") {
  const direct = entries.filter((entry) => entry.direct).length
  const prs = `${entries.length - direct} ${adjective ? `${adjective} ` : ""}PR(s)`
  return direct ? `${prs} and ${direct} direct commit(s)` : prs
}

function branchName(now, usedSuffixes) {
  const d = new Date(now)
  const date = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`
  const used = new Set(usedSuffixes)
  let n = 1
  while (used.has(String(n).padStart(2, "0"))) n++
  return `release/${date}-${String(n).padStart(2, "0")}`
}

// Cherry-pick model (2026-10-30 hourly-release decision, RELEASE-RISK-GATES.md).
//
// One release is in flight at a time. The moment it closes (tagged or
// deleted), the next slice cuts immediately at whatever's ready in dev.
// Ready PRs are picked, in dev order, onto `base` (the tagged tip production
// runs). A held PR is skipped, not a wall: everything merged after it still
// ships, and the held PR joins the line once a person signs it off with the
// `release:approved` label. That is what keeps the hourly line moving while
// a schema change or an events-path rewrite waits for manual QA.
//
// The cost of picking around a held PR is that a later PR can depend on it
// and still apply cleanly as a patch. The cut (release-cut.mjs) holds any
// pick that conflicts or comes out empty, naming the held PR it most likely
// needs from the `files` each PR carries here, and the release-verify
// workflow builds and tests the picked set before anything deploys; a pick
// that applies but breaks the build holds its PR as "pick failed verify" by
// hand (RELEASE-CUT.md).
//
// `prs` is every unreleased entry in dev order, direct commits among them:
// a ready one is picked in its dev position like a PR, a held one is listed
// with the rest of `held`. prCount counts the PRs, directCount the rest.
export function planRelease({ openReleases, prs, now, usedSuffixesToday = [], base, policy = DEFAULT_WALK_POLICY }) {
  const directCount = prs.filter((pr) => pr.direct).length
  const strip = ({ pathHolds, behindFloor, ...pr }) => pr
  // The held list is reported whether or not this run cuts: the hold nudge
  // (release-hold-nudge.mjs) reads it on every run, and a release in flight
  // is no reason to stop saying which PRs wait for a person.
  const held = prs.filter((pr) => prHolds(pr, policy)).map((pr) => ({ ...strip(pr), why: holdReason(pr) }))
  const ready = prs.filter((pr) => !prHolds(pr, policy)).map(strip)
  const common = { openReleases, prCount: prs.length - directCount, directCount, base, walkPolicy: policy }
  if (openReleases.length) {
    return { ...common, cut: false, reason: `release in flight: ${openReleases.join(", ")}`, prs: [], held }
  }
  if (!prs.length) return { ...common, cut: false, reason: "no unreleased PRs", prs: [], held }
  if (!ready.length) {
    return { ...common, cut: false, reason: `${tally(held)} waiting on a person, none ready`, prs: [], held }
  }
  return {
    ...common,
    cut: true,
    reason: `${tally(ready, "ready")}, ${held.length} held, no release in flight`,
    branch: branchName(now, usedSuffixesToday),
    areas: [...new Set(ready.flatMap((pr) => pr.areas))].sort(),
    prs: ready,
    held,
  }
}

// Which PR a first-parent commit stands for: GitHub's merge subject, or the
// "(#N)" suffix of a squash merge. Undefined for anything else.
export function prNumberFromSubject(subject) {
  const number = subject.match(/^Merge pull request #(\d+)/)?.[1] ?? subject.match(/\(#(\d+)\)$/)?.[1]
  return number === undefined ? undefined : Number(number)
}

// What a tagged release tip proves it carries from dev. A release branch is
// built by `git cherry-pick -x -m 1 <dev merge sha>` (release-cut.mjs, and
// DEPLOYMENT-ENVIRONMENTS "Cutting a release" by hand), so the calver tag
// sits on a pick, not on dev's first-parent line, and `<tag>..origin/dev`
// never shrinks on its own. Each pick keeps the dev merge's subject and adds
// a "(cherry picked from commit <sha>)" line to its body. That line is not a
// `key: value` trailer, so `%(trailers)` never sees it: read %b. A pick made
// without -x still carries the "Merge pull request #N" subject, so the PR
// number is the second, weaker key. A direct commit has no number: the -x
// line is the only proof production carries it, so a hand pick of one
// without -x leaves it in the plan.
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

// Every first-parent commit on dev that production does not run yet, oldest
// first, and the floor no slice may cut below: the merged PRs, and between
// them, in their dev position, the commits pushed straight to dev with no
// PR (`direct: true`, no number, the subject carried in place of a title).
// Until 2026-11-20 a direct commit was skipped here, so it was never
// picked, never listed as held and in no release notes; the release line
// then lacked its lines and every later PR built on them conflicted.
//
// The one commit left out is a direct commit that changes no file against
// its first parent (a merge that brought nothing in): there is nothing to
// pick, and a pick of it would come out empty.
//
// cwd is for tests driving a scratch repo.
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
  // The sha the next release branch starts from: the tagged tip itself, so
  // every hotfix picked straight onto a release branch is carried forward.
  const base = git(["rev-parse", `${released}^{commit}`], { cwd })
  const prs = []
  for (const { sha, mergedAt, subject, behindFloor } of unreleased) {
    const number = prNumberFromSubject(subject)
    if (number === undefined) {
      // Nobody reviewed a direct commit, so its rule reads every path it
      // touches: --no-renames lists a rename's old path beside the new one.
      const files = lines(git(["diff", "--name-only", "--no-renames", `${sha}^1`, sha], { cwd }))
      if (!files.length) continue
      // No PR, so no walk comment and no label will ever exist: `walk` is
      // "none" for the catalog-only commit the line picks and "unknown" for
      // the rest, and prHolds decides from the files alone.
      const walk = isLocaleCatalogOnly(files) ? "none" : "unknown"
      prs.push({ sha, subject, direct: true, mergedAt, walk, behindFloor, files, ...classifyFiles(files) })
      continue
    }
    const parent = subject.startsWith("Merge pull request") ? `${sha}^1` : `${sha}^`
    const files = lines(git(["diff", "--name-only", parent, sha], { cwd }))
    // Anything with a UI claim needs the GitHub-API walk lookup (see
    // release-plan-walk.mjs) to fill in walk; the git-only command here
    // always leaves those unknown, which holds.
    const walk = isDocsOrTestOnly(files) ? "none" : "unknown"
    // files rides along so the cut can say which held PR a pick that did
    // not land was built on, without a GitHub call of its own.
    prs.push({ number, sha, mergedAt, walk, behindFloor, files, ...classifyFiles(files) })
  }
  return { prs, floor, base }
}

async function main() {
  const nowArg = process.argv.find((arg) => arg.startsWith("--now="))
  const now = nowArg ? nowArg.slice(6) : new Date().toISOString()
  const unreleased = unreleasedPrs()
  let { prs } = unreleased
  // Without a token this stays the git-only command: every non-docs/test PR
  // reports walk: unknown and no gate result, so only PRs with no holding
  // area are ready.
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
    base: unreleased.base,
    policy: walkPolicy(),
  })
  console.log(JSON.stringify(plan, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
