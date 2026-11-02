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

// Picks each PR, in order, onto a new branch at `base`. A pick that
// conflicts is aborted and its PR reported as held ("pick conflict") rather
// than failing the cut: the PR behind it on dev may still apply, and a
// person resolves the conflict on the manual path. A merge commit is picked
// with -m 1 (its dev side); a squash commit has one parent and is picked
// as is. -x records the dev sha in the body, which is how release-plan.mjs
// later proves production carries the PR.
export function buildReleaseBranch({ branch, base, prs, cwd }) {
  const run = (args) => git(args, { cwd })
  run(["checkout", "-q", "-B", branch, base])
  const picked = []
  const conflicts = []
  for (const pr of prs) {
    const parents = run(["rev-list", "--parents", "-n", "1", pr.sha]).split(" ").length - 1
    const args = ["cherry-pick", "-x", ...(parents > 1 ? ["-m", "1"] : []), pr.sha]
    try {
      run(args)
      picked.push(pr)
    } catch (error) {
      // A conflict leaves a pick in progress to abort. Anything else (no git
      // identity, a bad sha) is the cut's own failure and must not be filed
      // as the PR's conflict: fail loud, the workflow reports it.
      try {
        run(["cherry-pick", "--abort"])
      } catch {
        throw error
      }
      conflicts.push({ ...pr, why: "pick conflict" })
    }
  }
  return { sha: run(["rev-parse", "HEAD"]), picked, conflicts }
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

  const built = buildReleaseBranch({ branch: plan.branch, base: plan.base, prs: plan.prs })
  if (!built.picked.length) {
    summary(`No cut: every ready PR conflicted with the base.\n\n${releaseNotes({ ...plan, prs: [], held: [...(plan.held ?? []), ...built.conflicts] }, titles)}`)
    return
  }
  const effective = { ...plan, sha: built.sha, prs: built.picked, held: [...(plan.held ?? []), ...built.conflicts] }
  const notes = releaseNotes(effective, titles)

  execFileSync("git", ["push", "origin", `${built.sha}:refs/heads/${plan.branch}`], { stdio: "inherit" })
  await githubApi(`/commits/${built.sha}/comments`, { token, method: "POST", body: { body: notes } })
  summary(`Cut \`${plan.branch}\` at \`${built.sha}\` (${built.picked.length} picked onto \`${plan.base}\`).\n\n${notes}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
