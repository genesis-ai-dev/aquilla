// Acts on one release-plan.mjs result: builds the planned release branch by
// cherry-picking every ready PR (and every ready direct commit, in its dev
// position) onto the tagged base, pushes it, and posts the release notes as
// a commit comment, exactly as RELEASE-CUT.md says.
// It decides nothing; the plan already did. The Release cut workflow
// (.github/workflows/release-cut.yml) runs it after a tag push, on the hour,
// or when a person presses the button.
// Usage: node scripts/release-cut.mjs <plan.json> [--plan-only]
//   GITHUB_TOKEN   contents: write, to push the branch and post the comment
//   GITHUB_STEP_SUMMARY   optional; the run summary gets the same notes
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { entryLabel, NOT_A_PR, tally } from "./release-plan.mjs"

const REPO = "genesis-ai-dev/aquilla"

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim()
const lines = (text) => text.split("\n").filter(Boolean)

// The held PR a pick most likely needs: the newest PR merged to dev before
// `pr` that is not on the branch (held by the plan, or left unpicked by this
// cut so far) whose merged diff touches one of `paths`. A pick conflicts or
// comes out empty because the branch lacks something the PR's dev parent
// had, and below the PR the branch lacks exactly those PRs. Read off the
// `files` the plan carries per PR, never a GitHub call; a plan without
// files gives no hint. Dev order is `mergedAt`, compared as instants (the
// planner writes it with the merge's own UTC offset, and dev's merges come
// from several time zones); a candidate without one is not ruled out, so
// a hand-built plan still gets a hint.
//
// A held direct commit (pushed to dev with no PR) is a candidate like any
// held PR, and the likelier one when a pick touches the files it changed:
// the answer is then its short sha, since it has no number. `pr` itself may
// be a direct commit; two entries are the same one by sha when either is
// direct, by PR number otherwise.
export function dependencyHint(pr, paths, candidates) {
  const when = (entry) => (entry.mergedAt === undefined ? undefined : Date.parse(entry.mergedAt))
  const at = when(pr)
  const isPick = (candidate) => (candidate.direct || pr.direct ? candidate.sha === pr.sha : candidate.number === pr.number)
  const before = (candidate) => {
    if (isPick(candidate)) return false
    const merged = when(candidate)
    return merged === undefined || at === undefined || merged <= at
  }
  const newestFirst = candidates
    .filter(before)
    .reverse()
    .sort((a, b) => (when(b) ?? 0) - (when(a) ?? 0))
  const needed = newestFirst.find((candidate) => candidate.files?.some((file) => paths.includes(file)))
  if (!needed) return undefined
  return needed.direct ? entryLabel(needed) : needed.number
}

// `needs` as dependencyHint answers: a PR number, or a direct commit's short sha.
const needsLabel = (needs) => (typeof needs === "number" ? `#${needs}` : `direct commit ${needs}`)
const conflictReason = (paths, needs) => `pick conflict in ${paths.join(", ")}${needs === undefined ? "" : `; needs ${needsLabel(needs)}`}`
const emptyReason = (needs) => `empty pick: already in base, or needs ${needs === undefined ? "a held PR" : needsLabel(needs)}`
const RECORDED_REASON = "already in base; recorded with the next cut that picks something"

// An empty pick the plan can prove production already carries: the plan
// lists the PR's files and every candidate's, and no PR still off the
// branch touches any of them. "Needs a held PR" is then impossible (a change
// that only exists relative to a held PR shares a file with it), so the base
// has the change, put there by a hand-built release that picked without -x
// or carried the same fix as its own commit (2026.11.16.02 did both).
export function provablyInBase(pr, candidates) {
  if (!pr.files?.length) return false
  if (!candidates.every((candidate) => Array.isArray(candidate.files))) return false
  return dependencyHint(pr, pr.files, candidates) === undefined
}

// How a failed `git cherry-pick` left the repo. A pick git stopped on is
// still in progress (CHERRY_PICK_HEAD exists): with unmerged paths it is a
// conflict; with nothing staged and nothing changed it is an empty pick
// ("The previous cherry-pick is now empty" on stderr, but the state is
// what counts, not the wording). Anything else is not a pick outcome: no
// pick in progress (a bad sha), or a pick that staged its change and then
// failed to commit (no git identity).
function stoppedPick(run) {
  try {
    run(["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"])
  } catch {
    return undefined
  }
  const unmerged = lines(run(["diff", "--name-only", "--diff-filter=U"]))
  if (unmerged.length) return { kind: "conflict", paths: unmerged }
  const staged = lines(run(["diff", "--cached", "--name-only"]))
  const changed = lines(run(["diff", "--name-only"]))
  if (!staged.length && !changed.length) return { kind: "empty", paths: [] }
  return undefined
}

// Picks each PR, in order, onto a new branch at `base`. A pick that does not
// land is reported as held rather than failing the cut (the PR behind it on
// dev may still apply), in one of two ways a person can act on:
//
// - conflict: git stopped on unmerged paths. The pick is aborted, and the
//   entry names the paths and, when the plan's files show one, the held PR
//   the change was built on ("needs #N"): approving that PR is the fix.
// - empty: git stopped with nothing to commit. Either the base already
//   carries the change, or the change only exists relative to a held PR
//   (a revert of one, say) and vanishes against the base.
//   When the plan proves the first (provablyInBase), the pick is committed
//   empty: its -x provenance is the record the planner reads, so the PR
//   stops appearing on every cut. Four PRs sat on every cut from 2026-11-16
//   as "empty pick" waiting for a person to record them by hand, and
//   nothing said how. Such a PR is `recorded`, not `picked`: it adds
//   nothing to the release, and a branch of nothing but records is not cut.
//   Otherwise the pick is skipped, never committed empty: provenance on a
//   change production lacks would mark the PR released. It is reported on
//   every cut until the held PR it needs ships.
//
// `held` is the plan's held list, with files: the candidates for "needs",
// together with the PRs this cut has already left unpicked.
//
// A merge commit is picked with -m 1 (its dev side); a squash commit, and a
// commit pushed straight to dev, has one parent and is picked as is. -x
// records the dev sha in the body, which is how release-plan.mjs later
// proves production carries the PR, and for a direct commit, which has no
// PR number in its subject, the only way it can.
export function buildReleaseBranch({ branch, base, prs, held = [], cwd }) {
  const run = (args) => git(args, { cwd })
  run(["checkout", "-q", "-B", branch, base])
  const picked = []
  const unpicked = []
  const recorded = []
  for (const pr of prs) {
    const parents = run(["rev-list", "--parents", "-n", "1", pr.sha]).split(" ").length - 1
    const args = ["cherry-pick", "-x", ...(parents > 1 ? ["-m", "1"] : []), pr.sha]
    try {
      run(args)
      picked.push(pr)
      continue
    } catch (error) {
      const stopped = stoppedPick(run)
      // Not a pick outcome (no git identity, a bad sha): the cut's own
      // failure, never filed as the PR's. Leave nothing in progress and
      // fail loud; the workflow reports it.
      if (!stopped) {
        try {
          run(["cherry-pick", "--abort"])
        } catch {
          // Nothing was in progress.
        }
        throw error
      }
      const candidates = [...held, ...unpicked]
      if (stopped.kind === "conflict") {
        run(["cherry-pick", "--abort"])
        const needs = dependencyHint(pr, stopped.paths, candidates)
        unpicked.push({ ...pr, kind: "conflict", paths: stopped.paths, ...(needs === undefined ? {} : { needs }), why: conflictReason(stopped.paths, needs) })
      } else if (provablyInBase(pr, candidates)) {
        // Finishes the stopped pick as an empty commit; the message git
        // prepared already ends with the -x provenance line.
        run(["commit", "--allow-empty", "--no-edit"])
        recorded.push({ ...pr, kind: "recorded", why: RECORDED_REASON })
      } else {
        run(["cherry-pick", "--skip"])
        const needs = dependencyHint(pr, pr.files ?? [], candidates)
        unpicked.push({ ...pr, kind: "empty", paths: [], ...(needs === undefined ? {} : { needs }), why: emptyReason(needs) })
      }
    }
  }
  return { sha: run(["rev-parse", "HEAD"]), picked, unpicked, recorded }
}

// A held or unpicked entry as the notes and the run summary name it: a PR by
// number; a direct commit by short sha and subject, because it has no PR
// page to open and the sha alone tells a person nothing.
const heldLabel = (entry) => (entry.direct && entry.subject ? `${entryLabel(entry)} "${entry.subject}"` : entryLabel(entry))

// What a person does about a direct commit held as "not a PR". There is no
// PR to carry `release:approved`, so the sign-off is the pick itself.
export const DIRECT_HELD_NOTE =
  "A direct commit has no PR to label: it stays held until a person picks it onto a release branch with `git cherry-pick -x <sha>` (docs/RELEASE-RISK-GATES.md, Cut)."

// RELEASE-CUT.md "Release notes template". titles maps PR number to title; a
// missing title prints as "(title unavailable)" rather than failing the cut.
// A direct commit's row carries its short sha and its subject, which the
// plan holds, so it needs no title lookup.
export function releaseNotes(plan, titles = {}) {
  const areas = plan.areas?.length ? ` · areas: ${plan.areas.join(", ")}` : ""
  const direct = plan.prs.filter((pr) => pr.direct).length
  const count = `${plan.prs.length - direct} PRs${direct ? ` + ${direct} direct commit${direct === 1 ? "" : "s"}` : ""}`
  const lines = [`## Release ${plan.branch} · ${count}${areas}`, ""]
  const title = (pr) => ((pr.direct ? pr.subject : titles[pr.number]) ?? "(title unavailable)").replaceAll("|", "\\|")
  lines.push("| PR | Title | Walk @ head sha | Areas |", "| --- | --- | --- | --- |")
  for (const pr of plan.prs) {
    const walk = pr.walk === "none" ? (pr.direct ? "none (locale catalogs, no PR)" : "none (docs only)") : pr.walk
    lines.push(`| ${entryLabel(pr)} | ${title(pr)} | ${walk} | ${pr.areas.length ? pr.areas.join(", ") : "—"} |`)
  }
  const recorded = plan.recorded ?? []
  if (recorded.length) {
    lines.push("", `**Recorded, no change:** ${recorded.map((pr) => entryLabel(pr)).join(", ")}. Production already carried these; the empty pick is the record.`)
  }
  const held = plan.held ?? []
  if (held.length) {
    lines.push("", `**Held, not in this release:** ${held.map((pr) => `${heldLabel(pr)} (${pr.why})`).join(", ")}.`)
    if (held.some((pr) => !pr.direct)) lines.push("A held PR joins the next cut once its gate is green or it carries the `release:approved` label.")
    if (held.some((pr) => pr.direct && pr.why.startsWith(NOT_A_PR))) lines.push(DIRECT_HELD_NOTE)
  }
  return lines.join("\n")
}

// One line per PR the cut could not pick, with the same reason the held
// line carries, so the run summary says which PR and why before anyone
// opens the notes.
export function unpickedReport(unpicked) {
  return unpicked.map((pr) => `- ${heldLabel(pr)}: ${pr.why}`).join("\n")
}

// The run summary of a plan that cuts nothing. A direct commit the plan
// holds is named here as well: no PR page shows it waiting, so the cut's
// own output is the only place a person will ever see it.
export function noCutSummary(plan) {
  const head = `No cut: ${plan.reason}.`
  const direct = (plan.held ?? []).filter((entry) => entry.direct)
  if (!direct.length) return head
  return `${head}\n\nDirect commits on dev waiting for a person:\n${unpickedReport(direct)}\n\n${DIRECT_HELD_NOTE}`
}

// The run summary's opening, before the notes: what landed, and when a
// pick did not, which PR and why. "No cut" here is not a conflict verdict:
// each unpicked PR carries its own reason.
export function cutSummary(plan, built) {
  const report = unpickedReport(built.unpicked)
  if (!built.picked.length) {
    return `No cut: none of the ${tally(plan.prs, "ready")} could be picked onto \`${plan.base}\`:\n${report}`
  }
  const notPicked = built.unpicked.length ? `, ${built.unpicked.length} not picked` : ""
  const head = `Cut \`${plan.branch}\` at \`${built.sha}\` (${built.picked.length} picked onto \`${plan.base}\`${notPicked}).`
  return built.unpicked.length ? `${head}\n\nNot picked by this cut:\n${report}` : head
}

async function githubApi(path, { token, method = "GET", body }) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: body && JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}`)
  return response.json()
}

// Titles for the PRs only: a direct commit has no PR to ask about, and its
// subject is already in the plan.
async function prTitles(prs, token) {
  const titles = {}
  await Promise.all(prs.filter((pr) => !pr.direct).map(async ({ number }) => {
    try {
      titles[number] = (await githubApi(`/pulls/${number}`, { token })).title
    } catch {
      // Left out: releaseNotes prints a placeholder instead.
    }
  }))
  return titles
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`)
  console.log(text)
}

async function main() {
  const [planPath] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
  const planOnly = process.argv.includes("--plan-only")
  const token = process.env.GITHUB_TOKEN
  const plan = JSON.parse(readFileSync(planPath, "utf8"))

  if (!plan.cut) {
    summary(noCutSummary(plan))
    return
  }

  const allPrs = [...plan.prs, ...(plan.held ?? [])]
  const titles = token ? await prTitles(allPrs, token) : {}
  if (planOnly) {
    summary(`Plan only, nothing pushed. A cut would create \`${plan.branch}\` from \`${plan.base}\`.\n\n${releaseNotes(plan, titles)}`)
    return
  }

  // Hard stop: two runs raced, or a person already cut by hand. Never
  // overwrite it or guess the next -NN.
  const existing = git(["ls-remote", "--heads", "origin", plan.branch])
  if (existing) throw new Error(`${plan.branch} already exists on origin; not overwriting it.`)

  const built = buildReleaseBranch({ branch: plan.branch, base: plan.base, prs: plan.prs, held: plan.held ?? [] })
  const held = [...(plan.held ?? []), ...built.unpicked]
  if (!built.picked.length) {
    // Nothing to release: the records stay local and are made again by the
    // next cut that has a pick to carry them.
    const waiting = [...held, ...built.recorded]
    summary(`${cutSummary(plan, { ...built, unpicked: [...built.unpicked, ...built.recorded] })}\n\n${releaseNotes({ ...plan, prs: [], held: waiting }, titles)}`)
    return
  }
  const effective = { ...plan, sha: built.sha, prs: built.picked, held, recorded: built.recorded }
  const notes = releaseNotes(effective, titles)

  execFileSync("git", ["push", "origin", `${built.sha}:refs/heads/${plan.branch}`], { stdio: "inherit" })
  await githubApi(`/commits/${built.sha}/comments`, { token, method: "POST", body: { body: notes } })
  summary(`${cutSummary(plan, built)}\n\n${notes}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
