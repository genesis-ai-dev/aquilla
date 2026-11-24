// Puts a PR's walk on its head commit as the `qa-walk` status, so a missing
// walk is visible on the PR before it merges instead of on the release cut
// after. The value is the planner's own (release-plan-walk.mjs,
// walkFromComments): same comments, same trusted authors, same head sha.
//
// Why it exists. QA-BOT-REGIMEN.md says a PR merges on a PASS walk, and
// nothing checked: from 2026-11-12, when CI previews were restricted to the
// dev access list and the walker could no longer sign in, PRs merged with a
// test-level walk or none, and the only place that showed was the held list
// of a release cut days later (36 of 47 PRs on 2026-11-19).
//
//   success  PASS, or no UI claim (a docs/test-only diff, or a NOT CHECKED walk)
//   failure  FAIL, FLAKY or BLOCKED at this head
//   pending  no walk at this head yet, or a PASS at test level only
//
// The status reports; it does not gate until branch protection on dev
// requires `qa-walk`, which is a repository setting and a decision
// (docs/RELEASE-RISK-GATES.md). Under the default walk policy the planner
// ships a `pending` PR, so the status is the one place a person sees that a
// change went out unwalked.
//
// Usage: node scripts/release-walk-status.mjs <pr-number>
//   GITHUB_TOKEN          statuses: write, pull-requests: read, issues: read
//   WALK_TRUSTED_LOGINS   as for the planner
import { pathToFileURL } from "node:url"
import { isDocsOrTestOnly } from "./release-plan.mjs"
import { prComments, walkFromComments, walkTrustedLogins } from "./release-plan-walk.mjs"

const REPO = "genesis-ai-dev/aquilla"
export const WALK_STATUS_CONTEXT = "qa-walk"

/** The commit status for one walk value. */
export function walkStatus(walk) {
  if (walk === "PASS") return { state: "success", description: "Walk PASS at this head" }
  if (walk === "none") return { state: "success", description: "No UI claim to walk" }
  if (walk === "fail") return { state: "failure", description: "The walk did not prove the claim at this head (FAIL, FLAKY or BLOCKED)" }
  if (walk === "partial") return { state: "pending", description: "Walk passed at test level only; nobody saw this head in a browser" }
  return { state: "pending", description: "No walk at this head yet" }
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

async function prFiles(number, token) {
  const files = []
  for (let page = 1; page <= 30; page++) {
    const rows = await githubApi(`/pulls/${number}/files?per_page=100&page=${page}`, { token })
    files.push(...rows.map((row) => row.filename))
    if (rows.length < 100) break
  }
  return files
}

async function main() {
  const number = Number(process.argv[2])
  const token = process.env.GITHUB_TOKEN
  if (!number || !token) throw new Error("usage: GITHUB_TOKEN=… node scripts/release-walk-status.mjs <pr-number>")
  const pr = await githubApi(`/pulls/${number}`, { token })
  if (pr.state !== "open") {
    console.log(JSON.stringify({ number, skipped: `PR is ${pr.state}` }))
    return
  }
  const headSha = pr.head.sha
  const walk = isDocsOrTestOnly(await prFiles(number, token))
    ? "none"
    : walkFromComments(await prComments(number, { token }), { number, headSha, trustedLogins: walkTrustedLogins() })
  const status = walkStatus(walk)
  await githubApi(`/statuses/${headSha}`, { token, method: "POST", body: { ...status, context: WALK_STATUS_CONTEXT } })
  console.log(JSON.stringify({ number, headSha, walk, ...status }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
