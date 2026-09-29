// Decides what the "Tag Live Release" workflow should do about the build
// production is serving right now. It reads aquilla.app/version.json, finds
// that commit on its release branch, and reports one of three outcomes:
//
//   tag    the live commit has no calver tag yet: verify it and tag it
//   skip   it is already tagged: nothing to do
//   error  the live build does not match a release branch on origin: a person
//          should look, so the job fails instead of guessing
//
// The decision is a pure function so the rules are tested without a network or
// a repository; main() does the fetching and the git lookups around it.
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const SHA = /^[0-9a-f]{7,40}$/
const RELEASE_BRANCH = /^release\/\d{4}\/\d{2}\/\d{2}(-\d{2})?$/

export function decideLiveRelease({ version, fullSha, onBranch, tags }) {
  const sha = typeof version?.sha === "string" ? version.sha : ""
  const branch = typeof version?.branch === "string" ? version.branch : ""
  if (!SHA.test(sha)) {
    return { action: "error", reason: `version.json has no usable sha (got '${sha}').` }
  }
  if (!RELEASE_BRANCH.test(branch)) {
    return {
      action: "error",
      reason: `The live build reports branch '${branch}', which is not a release/YYYY/MM/DD[-NN] branch.`,
    }
  }
  if (!fullSha) {
    return { action: "error", reason: `Live commit ${sha} is not on origin.` }
  }
  if (!onBranch) {
    return { action: "error", reason: `Live commit ${sha} is not on origin/${branch}.` }
  }
  if (tags.length > 0) {
    return { action: "skip", reason: `Already tagged ${tags.join(", ")}.`, sha: fullSha, branch, tags }
  }
  return { action: "tag", reason: `Live commit ${sha} on ${branch} has no release tag.`, sha: fullSha, branch, tags }
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
}

function gitSucceeds(...args) {
  try {
    execFileSync("git", args, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

async function readVersion(url) {
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`)
  return response.json()
}

async function main() {
  const url = process.env.LIVE_VERSION_URL || "https://aquilla.app/version.json"
  const version = await readVersion(url)

  // Only a branch that passed the release-branch pattern reaches a git ref.
  const branch = RELEASE_BRANCH.test(version?.branch ?? "") ? version.branch : ""
  if (branch) git("fetch", "--quiet", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`)
  git("fetch", "--quiet", "origin", "refs/tags/20*:refs/tags/20*")

  const sha = SHA.test(version?.sha ?? "") ? version.sha : ""
  let fullSha = ""
  if (sha) {
    try {
      fullSha = git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`)
    } catch {
      fullSha = ""
    }
  }
  const onBranch = Boolean(fullSha && branch) && gitSucceeds("merge-base", "--is-ancestor", fullSha, `origin/${branch}`)
  const tags = fullSha ? git("tag", "--points-at", fullSha, "--list", "20*").split("\n").filter(Boolean) : []

  const decision = decideLiveRelease({ version, fullSha, onBranch, tags })
  console.log(JSON.stringify(decision, null, 2))
  if (process.env.GITHUB_OUTPUT) {
    const lines = [`action=${decision.action}`, `reason=${decision.reason}`]
    if (decision.sha) lines.push(`sha=${decision.sha}`, `branch=${decision.branch}`)
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
  }
  if (decision.action === "error") {
    console.error(`ABORT: ${decision.reason}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ABORT: ${error.message}`)
    process.exit(1)
  })
}
