import { workersBuildMetadata } from "./assert-workers-build-env.mjs"
import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"

const REPO = "genesis-ai-dev/aquilla"
const MARKER = "<!-- aquilla-qa-preview -->"

// Notification errors must never turn a successful deployment into a failure.
export async function commentOnPreview({ env = process.env, urls, fetchImpl = fetch, warn = console.warn }) {
  const token = env.PREVIEW_GITHUB_TOKEN
  if (!token) {
    warn("[preview-comment] Configure PREVIEW_GITHUB_TOKEN to publish QA links on PRs.")
    return
  }
  try {
    const { branch, commitSha } = workersBuildMetadata(env)
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error("invalid commit")
    const expected = `https://${workersBuildPreviewAlias(branch)}-aquilla-web-preview.blue-darkness-7674.workers.dev`
    if (urls.web !== expected) throw new Error("invalid preview URL")
    // One deadline bounds pagination and all network calls combined.
    const signal = AbortSignal.timeout(30_000)
    const api = async (path, method = "GET", body) => {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method, signal, redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      // Never log response bodies or transport errors: they may contain secrets.
      if (!response.ok) throw new Error("GitHub request failed")
      return response.json()
    }
    const list = async (path) => {
      const results = []
      for (let page = 1; page <= 20; page++) {
        const rows = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
        if (!Array.isArray(rows)) throw new Error("invalid GitHub response")
        results.push(...rows)
        if (rows.length < 100) return results
      }
      throw new Error("pagination limit reached")
    }
    const matches = (pr) => pr.state === "open" && pr.head?.sha === commitSha
      && pr.head?.ref === branch && pr.head?.repo?.full_name === REPO
    const prs = await list(`/repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`genesis-ai-dev:${branch}`)}`)
    if (!prs.some(matches)) return
    const actor = await api("/user")
    if (!Number.isSafeInteger(actor.id)) throw new Error("invalid GitHub user")
    const body = `${MARKER}\n## QA preview\n\n[**Open preview**](${urls.web})\n\nDeployed commit: [\`${commitSha.slice(0, 8)}\`](https://github.com/${REPO}/commit/${commitSha}).\n\n[Build status and logs](https://github.com/${REPO}/commit/${commitSha}/checks). This link serves the latest successful deployment of this branch; compare the deployed commit with the PR before testing.\n\nUses shared development data. Email and optional AI integrations require preview credentials.`
    for (const pr of prs.filter(matches)) {
      if (!Number.isSafeInteger(pr.number)) continue
      const comments = await list(`/repos/${REPO}/issues/${pr.number}/comments`)
      const existing = comments.find((comment) => comment.user?.id === actor.id
        && comment.body?.startsWith(MARKER))
      // Recheck after listing comments so an older build cannot normally replace
      // a newer commit's notification. GitHub offers no atomic head+comment API.
      if (!matches(await api(`/repos/${REPO}/pulls/${pr.number}`))) continue
      if (existing?.body === body) continue
      if (existing) {
        if (!Number.isSafeInteger(existing.id)) throw new Error("invalid comment ID")
        await api(`/repos/${REPO}/issues/comments/${existing.id}`, "PATCH", { body })
      } else {
        await api(`/repos/${REPO}/issues/${pr.number}/comments`, "POST", { body })
      }
    }
  } catch {
    warn("[preview-comment] GitHub notification failed; deployment succeeded. Check token permissions/expiry and retry the build.")
  }
}
