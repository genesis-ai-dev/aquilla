// Acts on one release-plan.mjs result: builds the planned release branch by
// cherry-picking every ready PR onto the tagged base, pushes it, and posts
// the release notes as a commit comment, exactly as RELEASE-CUT.md says.
// It decides nothing; the plan already did. The Release cut workflow
// (.github/workflows/release-cut.yml) runs it after a tag push, on the hour,
// or when a person presses the button.
// Usage: node scripts/release-cut.mjs <plan.json> [--plan-only]
//   GITHUB_TOKEN   contents: write, to push the branch and post the comment
//   GITHUB_STEP_SUMMARY   optional; the run summary gets the same notes
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

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
export function dependencyHint(pr, paths, candidates) {
  const when = (entry) => (entry.mergedAt === undefined ? undefined : Date.parse(entry.mergedAt))
  const at = when(pr)
  const before = (candidate) => {
    if (candidate.number === pr.number) return false
    const merged = when(candidate)
    return merged === undefined || at === undefined || merged <= at
  }
  const newestFirst = candidates
    .filter(before)
    .reverse()
    .sort((a, b) => (when(b) ?? 0) - (when(a) ?? 0))
  return newestFirst.find((candidate) => candidate.files?.some((file) => paths.includes(file)))?.number
}

const conflictReason = (paths, needs) => `pick conflict in ${paths.join(", ")}${needs === undefined ? "" : `; needs #${needs}`}`
const emptyReason = (needs) => `empty pick: already in base, or needs ${needs === undefined ? "a held PR" : `#${needs}`}`

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
//   (a revert of one, say) and vanishes against the base. The pick is
//   skipped, never committed empty: an empty commit with -x provenance
//   would mark the PR released while production lacks its change. It is
//   reported on every cut until the held PR ships or a person records it
//   by hand, which is the point: nobody reads it as a conflict, and nobody
//   loses it.
//
// `held` is the plan's held list, with files: the candidates for "needs",
// together with the PRs this cut has already left unpicked.
//
// A merge commit is picked with -m 1 (its dev side); a squash commit has one
// parent and is picked as is. -x records the dev sha in the body, which is
// how release-plan.mjs later proves production carries the PR.
export function buildReleaseBranch({ branch, base, prs, held = [], cwd }) {
  const run = (args) => git(args, { cwd })
  run(["checkout", "-q", "-B", branch, base])
  const picked = []
  const unpicked = []
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
      } else {
        run(["cherry-pick", "--skip"])
        const needs = dependencyHint(pr, pr.files ?? [], candidates)
        unpicked.push({ ...pr, kind: "empty", paths: [], ...(needs === undefined ? {} : { needs }), why: emptyReason(needs) })
      }
    }
  }
  return { sha: run(["rev-parse", "HEAD"]), picked, unpicked }
}

// RELEASE-CUT.md "Release notes template". titles maps PR number to title; a
// missing title prints as "(title unavailable)" rather than failing the cut.
export function releaseNotes(plan, titles = {}) {
  const areas = plan.areas?.length ? ` · areas: ${plan.areas.join(", ")}` : ""
  const lines = [`## Release ${plan.branch} · ${plan.prs.length} PRs${areas}`, ""]
  const title = (number) => (titles[number] ?? "(title unavailable)").replaceAll("|", "\\|")
  lines.push("| PR | Title | Walk @ head sha | Areas |", "| --- | --- | --- | --- |")
  for (const pr of plan.prs) {
    const walk = pr.walk === "none" ? "none (docs only)" : pr.walk
    lines.push(`| #${pr.number} | ${title(pr.number)} | ${walk} | ${pr.areas.length ? pr.areas.join(", ") : "—"} |`)
  }
  const held = plan.held ?? []
  if (held.length) {
    lines.push("", `**Held, not in this release:** ${held.map((pr) => `#${pr.number} (${pr.why})`).join(", ")}.`)
    lines.push("A held PR joins the next cut once it carries the `release:approved` label.")
  }
  return lines.join("\n")
}

// One line per PR the cut could not pick, with the same reason the held
// line carries, so the run summary says which PR and why before anyone
// opens the notes.
export function unpickedReport(unpicked) {
  return unpicked.map((pr) => `- #${pr.number}: ${pr.why}`).join("\n")
}

// The run summary's opening, before the notes: what landed, and when a
// pick did not, which PR and why. "No cut" here is not a conflict verdict:
// each unpicked PR carries its own reason.
export function cutSummary(plan, built) {
  const report = unpickedReport(built.unpicked)
  if (!built.picked.length) {
    return `No cut: none of the ${plan.prs.length} ready PR(s) could be picked onto \`${plan.base}\`:\n${report}`
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

async function prTitles(prs, token) {
  const titles = {}
  await Promise.all(prs.map(async ({ number }) => {
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
    summary(`No cut: ${plan.reason}.`)
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
    summary(`${cutSummary(plan, built)}\n\n${releaseNotes({ ...plan, prs: [], held }, titles)}`)
    return
  }
  const effective = { ...plan, sha: built.sha, prs: built.picked, held }
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
