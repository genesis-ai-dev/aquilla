// Decides whether the open release branch may deploy itself, from what is
// recorded on its HEAD: the `release-verify` check (release-verify.yml) and
// smart Jev's commit comment (docs/runbooks/smart-testing-webhook.md). The
// hourly deploy workflow (release-deploy.yml) acts on this JSON and judges
// nothing itself. Deterministic and read-only.
//
// Both signals are required, and both are for this exact sha: a result on
// an older commit of the branch never decides a newer HEAD (RELEASE-CUT.md).
//   release-verify   must have concluded `success`
//   Jev              must have posted; a FAIL holds, PASS / INCONCLUSIVE /
//                    HARNESS UNAVAILABLE do not (same rule as the manual
//                    deploy). No comment yet means wait: the hour's deploy
//                    goes by, the next one reads it again.
//
// Usage: node scripts/release-deploy-check.mjs
//   GITHUB_TOKEN   contents: read
// Prints {"deploy": bool, "reason": string, "branch"?, "sha"?}.
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import { isReleaseBranch } from "./release-plan.mjs"

const REPO = "genesis-ai-dev/aquilla"
export const VERIFY_CHECK_NAME = "release-verify"
const JEV_MARKER = "<!-- aquilla-smart-tests -->"

// The four decision lines scripts/smart-test-comment.mjs writes on a
// release-branch comment. Anything else in a marker comment is "no
// decision": the run is still being reported, or the format moved.
const JEV_DECISIONS = [
  [/\*\*FAIL — this release HEAD does not deploy\.\*\*/, "fail"],
  [/\*\*PASS — a person may deploy this release HEAD\.\*\*/, "pass"],
  [/\*\*INCONCLUSIVE — this does not hold the deploy\.\*\*/, "inconclusive"],
  [/\*\*HARNESS UNAVAILABLE does not hold this deploy\.\*\*/, "unavailable"],
]

// Who may decide a deploy. The Hetzner runner reports with the owner's own
// GitHub identity (docs/runbooks/smart-testing-webhook.md, "The reporting
// credential"); a GitHub App can replace it by changing this list, or
// JEV_TRUSTED_LOGINS in the deploy workflow. Any collaborator can post a
// commit comment, so the marker alone must never decide a production deploy.
export const DEFAULT_JEV_TRUSTED_LOGINS = ["ryderwishart"]

export function jevTrustedLogins(env = process.env) {
  const configured = (env.JEV_TRUSTED_LOGINS ?? "").split(",").map((login) => login.trim()).filter(Boolean)
  return configured.length ? configured : DEFAULT_JEV_TRUSTED_LOGINS
}

// comments: [{ body, login }], oldest first as the API lists them. Only a
// trusted author's marker comments count. Among those, a FAIL holds whatever
// came after it: a later PASS on the same HEAD is a re-run that disagreed
// with itself, and the hold is the safe reading. Otherwise the newest wins.
export function jevDecision(comments, trustedLogins = DEFAULT_JEV_TRUSTED_LOGINS) {
  let decision = null
  for (const comment of comments) {
    const body = comment?.body
    if (typeof body !== "string" || !body.includes(JEV_MARKER)) continue
    if (!trustedLogins.includes(comment.login)) continue
    for (const [pattern, name] of JEV_DECISIONS) {
      if (!pattern.test(body)) continue
      if (decision !== "fail") decision = name
    }
  }
  return decision
}

export function decide({ verify, jev }) {
  if (verify !== "success") return { deploy: false, reason: `${VERIFY_CHECK_NAME} is ${verify ?? "missing"}` }
  if (jev === null) return { deploy: false, reason: "Jev has not reported on this HEAD yet" }
  if (jev === "fail") return { deploy: false, reason: "Jev FAIL on this HEAD" }
  return { deploy: true, reason: `${VERIFY_CHECK_NAME} success, Jev ${jev}` }
}

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim()

// The one release branch in flight: a release/* branch whose HEAD carries no
// calver tag. Two at once is a person's doing and stops the deploy.
export function openReleaseBranches() {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/"])
    .split("\n")
    .filter(Boolean)
    .map((ref) => ref.replace(/^origin\//, ""))
    .filter(isReleaseBranch)
    .filter((branch) => !git(["tag", "--points-at", `origin/${branch}`, "--list", "20*"]))
}

async function githubApi(path, token) {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`GitHub GET ${path} failed: HTTP ${response.status}`)
  return response.json()
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("GITHUB_TOKEN is required")
  const open = openReleaseBranches()
  if (open.length !== 1) {
    console.log(JSON.stringify({ deploy: false, reason: open.length ? `more than one release in flight: ${open.join(", ")}` : "no release in flight" }))
    return
  }
  const [branch] = open
  const sha = git(["rev-parse", `origin/${branch}`])
  const checks = await githubApi(`/commits/${sha}/check-runs?check_name=${VERIFY_CHECK_NAME}&per_page=50`, token)
  const runs = Array.isArray(checks?.check_runs) ? checks.check_runs : []
  const newest = runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0]
  const verify = newest ? (newest.status === "completed" ? newest.conclusion : newest.status) : undefined
  const comments = await githubApi(`/commits/${sha}/comments?per_page=100`, token)
  const jev = jevDecision(
    (Array.isArray(comments) ? comments : []).map((comment) => ({ body: comment.body, login: comment.user?.login })),
    jevTrustedLogins(),
  )
  console.log(JSON.stringify({ branch, sha, ...decide({ verify, jev }) }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
