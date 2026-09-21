import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

const REPO = "genesis-ai-dev/aquilla"
const MARKER = "<!-- aquilla-smart-tests -->"
const escape = (value) => String(value).replace(/[&<>|`\r\n]/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "&#124;", "`": "&#96;", "\r": " ", "\n": " " })[char])

export function renderReport({ sha, phase, suite, runUrl, jobStatus }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected an exact commit SHA")
  if (!["running", "finished"].includes(phase)) throw new Error("Invalid report phase")
  const hostedEvidence = /^https:\/\/koinegreek\.app\/aquilla-qa\/artifacts\/[a-f0-9]{64}\/suite\.json$/.test(runUrl ?? "")
  if (runUrl && !hostedEvidence && !/^https:\/\/github\.com\/genesis-ai-dev\/aquilla\/actions\/runs\/\d+$/.test(runUrl)) {
    throw new Error("Invalid workflow URL")
  }
  const lines = [MARKER, "## Jev smart testing", "",
    `Commit: [\`${sha.slice(0, 8)}\`](https://github.com/${REPO}/commit/${sha}).`, "",
    "Jev walks user journeys on a reset, isolated local stack built from this commit. Independent checks verify server state and fresh browser sessions.", ""]
  if (phase === "running") {
    lines.push("**Starting.** The runner has started setup. No outcome has passed yet.")
  } else {
    const valid = suite?.schemaVersion === 2 && suite.build === sha && suite.dirty === false
      && Array.isArray(suite.planned) && suite.planned.length > 0 && Array.isArray(suite.tests)
    if (!valid) {
      lines.push("**INCONCLUSIVE.** No complete, clean-checkout evidence matches this commit. Setup, execution, or evidence collection failed.")
    } else {
      const remaining = [...suite.planned]
      let verified = suite.status === "passed" && (!jobStatus || jobStatus === "success")
      let cost = 0
      let costReported = 0
      let modelCalls = 0
      const rows = []
      for (const test of suite.tests) {
        const index = remaining.indexOf(test.title)
        if (index < 0) verified = false
        else remaining.splice(index, 1)
        const evidence = test.evidence?.["smart-testing-evidence"]
        const live = test.title?.startsWith("Jev ") && !test.evidence?.["dom-audit"]
        let verdict = test.status === "passed" ? "PASS (model-free check)" : "INCONCLUSIVE"
        if (live) {
          const sameBuild = evidence?.build === sha && evidence?.dirty === false
          const checks = evidence?.outcome?.checks
          const checksPass = checks && Object.keys(checks).length > 0 && Object.values(checks).every((value) => value === true)
          const passed = sameBuild && test.status === "passed" && evidence?.outcome?.verdict === "passed"
            && checksPass && evidence?.inputObserved === true
            && !["driver_error", "timed_out", "budget_exhausted", "incomplete"].includes(evidence?.agent?.status)
            && typeof evidence?.agent?.status === "string"
          verdict = passed ? "VERIFIED PASS" : sameBuild && evidence?.outcome?.verdict === "product_failure"
            ? "PRODUCT FAILURE" : "INCONCLUSIVE"
        } else if (!test.evidence?.["oracle-qualification"] && !test.evidence?.["dom-audit"]) {
          verdict = "INCONCLUSIVE"
        }
        if (!["VERIFIED PASS", "PASS (model-free check)"].includes(verdict)) verified = false
        const calls = evidence?.agent?.modelCalls ?? []
        for (const call of calls) {
          modelCalls++
          if (typeof call.usage?.cost === "number" && Number.isFinite(call.usage.cost) && call.usage.cost >= 0) {
            cost += call.usage.cost
            costReported++
          }
        }
        rows.push(`| ${escape(test.title)} | ${verdict} | ${(Number(test.durationMs) / 1000).toFixed(1)} s |`)
      }
      for (const title of remaining) rows.push(`| ${escape(title)} | NOT RUN | — |`)
      if (remaining.length) verified = false
      lines.push(verified ? "**PASS — all listed outcomes verified.**" : "**NOT A PASS — review failures and incomplete checks.**",
        "", "| Journey | Result | Duration |", "| --- | --- | --- |", ...rows,
        "", `Provider-reported model cost: $${cost.toFixed(6)} (${costReported}/${modelCalls} calls report cost; excludes runner compute).`)
      if (suite.parallel) {
        const timing = suite.parallel
        lines.push("", `Parallel execution: ${Number(timing.shards)} isolated stacks; `
          + `${(Number(timing.wallMs) / 1000).toFixed(1)} s including setup; `
          + `${(Number(timing.longestShardTestMs) / 1000).toFixed(1)} s for the slowest test shard.`)
      }
    }
  }
  if (suite?.harnessBuild) lines.push("", `Reviewed harness: \`${escape(suite.harnessBuild.slice(0, 8))}\`. PR code cannot replace these checks.`)
  if (suite?.runner) lines.push("", `Hetzner: ${(Number(suite.runner.wallMs) / 1000).toFixed(1)} s including source preparation and setup; one active suite.`)
  if (runUrl) lines.push("", hostedEvidence
    ? `[Download outcome evidence](${runUrl}) (private bearer link; expires after seven days).`
    : `[Run logs and downloadable evidence](${runUrl}).`)
  lines.push("", "Advisory coverage, not a release guarantee. No retries convert a failed journey into a pass. Preview deployment and workflows outside these journeys are not verified by this run.")
  return lines.join("\n")
}

/** Trusted reporting process: never imports or executes code from the PR. */
export async function publishReport({ pr, sha, body, token, author, fetchImpl = fetch }) {
  if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid PR identity")
  const api = async (route, method = "GET", payload) => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPO}${route}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    if (!response.ok) throw new Error(`GitHub report request failed: HTTP ${response.status}`)
    return response.json()
  }
  const matches = (pull) => pull.state === "open" && pull.head?.sha === sha && pull.head?.repo?.full_name === REPO
  if (!matches(await api(`/pulls/${pr}`))) return "superseded"
  let existing
  for (let page = 1; page <= 20; page++) {
    const comments = await api(`/issues/${pr}/comments?per_page=100&page=${page}`)
    existing ??= comments.find((comment) => comment.user?.login === author && comment.body?.startsWith(MARKER))
    if (comments.length < 100) break
    if (page === 20) throw new Error("Comment pagination limit reached")
  }
  if (!matches(await api(`/pulls/${pr}`))) return "superseded"
  if (existing?.body === body) return "unchanged"
  if (existing && !Number.isSafeInteger(existing.id)) throw new Error("Invalid comment ID")
  await api(existing ? `/issues/comments/${existing.id}` : `/issues/${pr}/comments`, existing ? "PATCH" : "POST", { body })
  return existing ? "updated" : "created"
}

async function main() {
  const [phase, prValue, sha, evidencePath] = process.argv.slice(2)
  let suite
  if (evidencePath) {
    try { suite = JSON.parse(readFileSync(evidencePath, "utf8")) } catch { /* Report missing evidence honestly. */ }
  }
  const body = renderReport({ sha, phase, suite, runUrl: process.env.SMART_RUN_URL, jobStatus: process.env.SMART_JOB_STATUS })
  const token = process.env.GITHUB_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
  const author = process.env.GITHUB_ACTIONS === "true" ? "github-actions[bot]"
    : execFileSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8" }).trim()
  console.log(await publishReport({ pr: Number(prValue), sha, body, token, author }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Smart-test reporting failed; no success comment was fabricated."); process.exitCode = 1 })
}
