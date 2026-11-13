// What to do when the hourly deploy finds the open release branch held by a
// failed `release-verify` check (release-deploy.yml, the check job). Reads
// the check job's JSON, finds the Release verify run for that HEAD and its
// failed jobs, and classifies the failure from the job logs:
//
//   infra   the log shows a runner or network fault (an install download
//           timed out, the runner lost its connection, …). On the run's
//           first attempt this script asks GitHub to rerun the failed jobs;
//           the next hourly check then reads a green check and deploys.
//   code    anything else: a test, type or build failure in the slice. No
//           rerun — a person or the release agent has to look.
//
// A run already rerun once is never rerun again by this script: a second
// identical infra failure is worth a person's eyes, and a loop of reruns
// would hide a broken runner image for days.
//
// Prints {"action": "rerun" | "alert" | "none", "reason", ...}. It never
// deploys and never touches the branch.
import { pathToFileURL } from "node:url"

const REPO = "genesis-ai-dev/aquilla"
const VERIFY_WORKFLOW_NAME = "Release verify"

// Log lines that mean the runner, not the slice, failed. Each is a fault we
// have seen hold a release (2026-11-06: onnxruntime-node's postinstall could
// not reach its download host for 11 hours of hourly checks).
export const INFRA_PATTERNS = [
  /\bETIMEDOUT\b/,
  /\bENETUNREACH\b/,
  /\bECONNRESET\b/,
  /\bEAI_AGAIN\b/,
  /\bECONNREFUSED\b.*(?:registry|github|download)/i,
  /The runner has received a shutdown signal/,
  /lost communication with the server/,
  /The operation was canceled/,
  /No space left on device/,
  /ERR_PNPM_FETCH_(?:404|5\d\d|TIMEOUT)/,
  /ERR_PNPM_META_FETCH_FAIL/,
  /Failed to (?:download|fetch) .*(?:tar|tgz|zip|node)/i,
  /\b(?:502|503|504) (?:Bad Gateway|Service Unavailable|Gateway Timeout)\b/,
  /Resource temporarily unavailable/,
]

/** Whether a failed job's log reads as a runner or network fault rather than a failure in the code. */
export function isInfraFailure(log) {
  return INFRA_PATTERNS.some((pattern) => pattern.test(log))
}

/** The one-line excerpt worth quoting: the first infra line, else the first `##[error]` line, else the last non-empty line. */
export function failureExcerpt(log) {
  const lines = String(log).split("\n").map((line) => line.replace(/^\S+Z /, "").trim())
  const infra = lines.find((line) => isInfraFailure(line))
  if (infra) return infra
  const error = lines.find((line) => line.includes("##[error]"))
  if (error) return error.replace("##[error]", "").trim()
  return lines.filter(Boolean).at(-1) ?? ""
}

/**
 * Decide from the failed jobs and the run's attempt count. `jobs` carries
 * each failed job's name and log; `attempt` is the run's run_attempt.
 */
export function decideStall({ jobs, attempt }) {
  if (!jobs.length) return { action: "alert", kind: "unknown", reason: "release-verify failed but no job reports a failure" }
  const classified = jobs.map((job) => ({ name: job.name, infra: isInfraFailure(job.log), excerpt: failureExcerpt(job.log) }))
  const allInfra = classified.every((job) => job.infra)
  if (allInfra && attempt < 2) return { action: "rerun", kind: "infra", reason: "every failed job shows a runner or network fault; rerunning failed jobs once", jobs: classified }
  if (allInfra) return { action: "alert", kind: "infra", reason: `runner or network fault again on attempt ${attempt}; not rerunning a second time`, jobs: classified }
  return { action: "alert", kind: "code", reason: "a failed job shows a failure in the slice, not the runner", jobs: classified }
}

async function githubApi(path, token, { raw = false, method = "GET" } = {}) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    redirect: raw ? "follow" : "error",
    signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}`)
  return raw ? response.text() : response.json()
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("GITHUB_TOKEN is required")
  const checkPath = process.argv[2]
  if (!checkPath) throw new Error("usage: release-stall.mjs <check.json>")
  const check = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(checkPath, "utf8")))

  if (check.deploy || !/^release-verify is failure/.test(check.reason ?? "") || !check.sha) {
    console.log(JSON.stringify({ action: "none", reason: `not a verify failure: ${check.reason}` }))
    return
  }

  const runs = await githubApi(`/actions/runs?head_sha=${check.sha}&per_page=20`, token)
  const run = (runs.workflow_runs ?? []).filter((r) => r.name === VERIFY_WORKFLOW_NAME).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  if (!run) {
    console.log(JSON.stringify({ action: "alert", kind: "unknown", reason: "release-verify failed but no Release verify run exists for this HEAD", branch: check.branch, sha: check.sha }))
    return
  }

  const jobsPage = await githubApi(`/actions/runs/${run.id}/jobs?per_page=100`, token)
  const failed = (jobsPage.jobs ?? []).filter((job) => job.conclusion === "failure" && job.name !== "release-verify")
  const jobs = []
  for (const job of failed) {
    const log = await githubApi(`/actions/jobs/${job.id}/logs`, token, { raw: true }).catch((error) => `log unavailable: ${error.message}`)
    jobs.push({ name: job.name, log })
  }

  const decision = decideStall({ jobs, attempt: run.run_attempt ?? 1 })
  const stalledMinutes = Math.round((Date.now() - new Date(run.created_at).getTime()) / 60_000)
  if (decision.action === "rerun") {
    await githubApi(`/actions/runs/${run.id}/rerun-failed-jobs`, token, { method: "POST" })
  }
  console.log(JSON.stringify({ ...decision, branch: check.branch, sha: check.sha, runId: run.id, runUrl: run.html_url, attempt: run.run_attempt, stalledMinutes }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
