// Fills the release planner's `walk` field from the QA bot's PR comments.
// Kept apart from release-plan.mjs on purpose: this is the only part of the
// planner that calls the GitHub API, so a lookup bug can't hide inside the
// slicing logic, and the slicing logic stays testable with no network.
import { APPROVED_LABEL } from "./release-risk.mjs"

const REPO = "genesis-ai-dev/aquilla"

// PR-BOT.md's heading and verdict line: "## Bot walk — PR <n> @ <sha>"
// followed by a line opening "**PASS**", "**FAIL**", "**FLAKY**",
// "**BLOCKED**", or "**NOT CHECKED**". <sha> is the PR's own head sha, not
// the dev merge commit. The bot writes it full or abbreviated (7+ hex),
// sometimes in backticks, and a re-walk adds a note in parentheses after it
// ("@ <sha> (rewalk)"); all of those are the same walk heading.
const WALK_HEADING = /^## Bot walk — PR #?(\d+) @ `?([0-9a-f]{7,40})`?(?: \([^)\n]*\))?\s*$/m
const VERDICT_LINE = /^\*\*(PASS|FAIL|FLAKY|BLOCKED|NOT CHECKED)\*\*/

// FLAKY and BLOCKED both mean the bot could not prove the outcome; the
// release planner holds on either exactly like a FAIL. NOT CHECKED means the
// bot found no UI claim to walk (a scripts/CLI-only diff, same idea as
// isDocsOrTestOnly's path check in release-plan.mjs, just caught here
// instead because the diff isn't purely docs/test files) — that's not a
// hold, it's the bot correctly declining to invent a PASS.
export function normalizeVerdict(verdict) {
  if (verdict === "PASS") return "PASS"
  if (verdict === "NOT CHECKED") return "none"
  return "fail"
}

// Parses one comment body. Returns null for a comment that isn't a bot-walk
// comment, or whose verdict line doesn't parse, rather than guessing.
export function parseWalkComment(body) {
  if (typeof body !== "string") return null
  const heading = WALK_HEADING.exec(body)
  if (!heading) return null
  const afterHeading = body.slice(heading.index + heading[0].length)
  const verdictLine = afterHeading.split("\n").find((line) => line.trim().length > 0)
  const verdict = verdictLine && VERDICT_LINE.exec(verdictLine.trim())
  if (!verdict) return null
  return { prNumber: Number(heading[1]), sha: heading[2], verdict: verdict[1] }
}

async function githubApi(path, { repo, token, fetchImpl }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status}`)
  return response.json()
}

async function listComments(prNumber, opts) {
  const comments = []
  for (let page = 1; page <= 20; page++) {
    const rows = await githubApi(`/issues/${prNumber}/comments?per_page=100&page=${page}`, opts)
    if (!Array.isArray(rows)) break
    comments.push(...rows)
    if (rows.length < 100) break
  }
  return comments
}

// Resolves one dev-branch merge commit to the PR it closed: its walk
// verdict and whether a person signed it off for release. `walk` is
// `unknown` in every case where a verdict isn't possible yet: no associated
// PR, no matching comment, or a comment whose sha is stale because the walk
// ran before a later push. When several walks name the head sha (a re-walk
// after a fixture change, say), the newest one wins. `approved` is the
// `release:approved` label (release-risk.mjs): the manual QA path's
// sign-off, read off the same /pulls response so it costs no extra call.
export async function lookupPr({ mergeSha, repo = REPO, token, fetchImpl = fetch }) {
  const opts = { repo, token, fetchImpl }
  // The commit subject often carries the PR number too, but not reliably for
  // a squash merge; this endpoint is what actually resolves it, along with
  // the PR's head sha (also not derivable from a squash commit on dev).
  const associated = await githubApi(`/commits/${mergeSha}/pulls`, opts)
  const candidates = Array.isArray(associated) ? associated : []
  const pr = candidates.find((candidate) => candidate.merge_commit_sha === mergeSha) ?? candidates[0]
  if (!pr?.number || !pr.head?.sha) return { walk: "unknown", approved: false }
  const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => label?.name) : []
  const approved = labels.includes(APPROVED_LABEL)

  let latest = null
  for (const comment of await listComments(pr.number, opts)) {
    const parsed = parseWalkComment(comment.body)
    if (parsed && parsed.prNumber === pr.number && pr.head.sha.startsWith(parsed.sha)) latest = parsed
  }
  return { walk: latest ? normalizeVerdict(latest.verdict) : "unknown", approved }
}

export async function lookupWalk(options) {
  return (await lookupPr(options)).walk
}

// Fills `walk` and `approved` for every PR. A docs/test-only PR is already
// "none" from isDocsOrTestOnly, but its label still has to be read (a
// person can approve anything), so every PR gets the one lookup. One PR's
// lookup failing never blocks the others; it just stays "unknown", which
// holds.
export async function fillWalks(prs, opts) {
  return Promise.all(prs.map(async (pr) => {
    try {
      const { walk, approved } = await lookupPr({ ...opts, mergeSha: pr.sha })
      return { ...pr, walk: pr.walk === "none" ? "none" : walk, approved }
    } catch {
      return pr
    }
  }))
}
