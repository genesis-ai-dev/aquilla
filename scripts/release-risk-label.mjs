// Puts a PR's risk areas on it as `risk:<area>` labels, from the files it
// touches (release-risk.mjs). The labels are for people: a reviewer sees at
// a glance that a PR will wait for a person before it ships, and the risk
// label workflow routes it to review. The planner does not read them; it
// classifies the merged diff itself, so a label a person removes changes
// nothing. The one label the planner reads is `release:approved`, which
// this script never touches.
// Usage: node scripts/release-risk-label.mjs <pr-number>
//   GITHUB_TOKEN   pull-requests: write
import { pathToFileURL } from "node:url"
import { APPROVED_LABEL, RISK_LABEL_PREFIX, classifyFiles, riskLabelsFor } from "./release-risk.mjs"

const REPO = "genesis-ai-dev/aquilla"

// Given what the PR carries now and what its files say, which labels to add
// and which to remove. Only `risk:*` labels are ever removed; every other
// label, `release:approved` included, is left as it is.
export function labelDelta(current, areas) {
  const wanted = new Set(riskLabelsFor(areas))
  const have = new Set(current)
  const add = [...wanted].filter((label) => !have.has(label))
  const remove = current.filter((label) => label.startsWith(RISK_LABEL_PREFIX) && !wanted.has(label) && label !== APPROVED_LABEL)
  return { add, remove }
}

async function githubApi(path, { token, method = "GET", body }) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: body && JSON.stringify(body),
  })
  if (!response.ok && response.status !== 404) throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

async function prFiles(number, token) {
  const files = []
  for (let page = 1; page <= 30; page++) {
    const rows = await githubApi(`/pulls/${number}/files?per_page=100&page=${page}`, { token })
    if (!Array.isArray(rows)) break
    files.push(...rows.map((row) => row.filename))
    if (rows.length < 100) break
  }
  return files
}

async function main() {
  const number = Number(process.argv[2])
  const token = process.env.GITHUB_TOKEN
  if (!number || !token) throw new Error("usage: GITHUB_TOKEN=… node scripts/release-risk-label.mjs <pr-number>")
  const files = await prFiles(number, token)
  const { areas, pathHolds } = classifyFiles(files)
  const pr = await githubApi(`/pulls/${number}`, { token })
  const current = (pr?.labels ?? []).map((label) => label.name)
  const { add, remove } = labelDelta(current, areas)
  if (add.length) await githubApi(`/issues/${number}/labels`, { token, method: "POST", body: { labels: add } })
  for (const label of remove) await githubApi(`/issues/${number}/labels/${encodeURIComponent(label)}`, { token, method: "DELETE" })
  console.log(JSON.stringify({ number, files: files.length, areas, pathHolds, add, remove }))
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs")
    appendFileSync(process.env.GITHUB_OUTPUT, `holds=${pathHolds}\nareas=${areas.join(",")}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
