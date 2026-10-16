// Acts on one release-plan.mjs result: pushes the planned release branch and
// posts the release notes as a commit comment, exactly as RELEASE-CUT.md says.
// It decides nothing; the plan already did. The Release cut workflow
// (.github/workflows/release-cut.yml) runs it when a person presses the button.
// Usage: node scripts/release-cut.mjs <plan.json> [--plan-only]
//   GITHUB_TOKEN   contents: write, to push the branch and post the comment
//   GITHUB_STEP_SUMMARY   optional; the run summary gets the same notes
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const REPO = "genesis-ai-dev/aquilla"

// RELEASE-CUT.md "Release notes template". titles maps PR number to title; a
// missing title prints as "(title unavailable)" rather than failing the cut.
export function releaseNotes(plan, titles = {}) {
  const areas = plan.areas?.length ? ` · areas: ${plan.areas.join(", ")}` : ""
  const lines = [`## Release ${plan.branch} · ${plan.prs.length} PRs${areas}`, ""]
  if (plan.hold) lines.push(`**Held:** ${plan.reason}`, "")
  lines.push("| PR | Title | Walk @ head sha | Areas |", "| --- | --- | --- | --- |")
  for (const pr of plan.prs) {
    const walk = pr.walk === "none" ? "none (docs only)" : pr.walk
    const title = (titles[pr.number] ?? "(title unavailable)").replaceAll("|", "\\|")
    lines.push(`| #${pr.number} | ${title} | ${walk} | ${pr.areas.length ? pr.areas.join(", ") : "—"} |`)
  }
  const needs = plan.prs.filter((pr) => pr.walk !== "PASS" && pr.walk !== "none")
  lines.push("", needs.length
    ? `Needs a human: ${needs.map((pr) => `#${pr.number} (walk ${pr.walk})`).join(", ")}.`
    : "Needs a human: none")
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

  const notes = releaseNotes(plan, token ? await prTitles(plan.prs, token) : {})
  if (planOnly) {
    summary(`Plan only, nothing pushed. A cut would create \`${plan.branch}\` at \`${plan.sha}\`.\n\n${notes}`)
    return
  }

  // Hard stop: two runs raced, or a person already cut by hand. Never
  // overwrite it or guess the next -NN.
  const existing = execFileSync("git", ["ls-remote", "--heads", "origin", plan.branch], { encoding: "utf8" }).trim()
  if (existing) throw new Error(`${plan.branch} already exists on origin; not overwriting it.`)

  execFileSync("git", ["push", "origin", `${plan.sha}:refs/heads/${plan.branch}`], { stdio: "inherit" })
  await githubApi(`/commits/${plan.sha}/comments`, { token, method: "POST", body: { body: notes } })
  summary(`Cut \`${plan.branch}\` at \`${plan.sha}\`.\n\n${notes}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
