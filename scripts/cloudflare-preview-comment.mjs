import { createSign } from "node:crypto"

import { workersBuildMetadata } from "./assert-workers-build-env.mjs"
import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"

const REPO = "genesis-ai-dev/aquilla"
const MARKER = "<!-- aquilla-qa-preview -->"
const API_VERSION = "2026-03-10"

// The comment is posted by the "Aquilla QA" GitHub App (aquilla-qa-bot), not
// by a person. The build holds the App's id, its installation id on this repo,
// and one of its private keys; the script proves it is the App by signing a
// short-lived JWT, then trades that for a one-hour installation token scoped
// to pull-request writes only.
export function appCredentials(env = process.env) {
  const problems = []
  const id = (name) => {
    const value = Number(env[name])
    if (!Number.isSafeInteger(value) || value <= 0) problems.push(`${name} ${env[name] ? "is not a positive integer" : "is missing"}`)
    return value
  }
  const appId = id("PREVIEW_GITHUB_APP_ID")
  const installationId = id("PREVIEW_GITHUB_APP_INSTALLATION_ID")
  // Cloudflare build variables do not reliably keep PEM line breaks, so the
  // key is stored base64-encoded. A raw PEM is accepted too.
  const raw = env.PREVIEW_GITHUB_APP_PRIVATE_KEY?.trim()
  const privateKey = !raw ? "" : raw.startsWith("-----BEGIN") ? raw : Buffer.from(raw, "base64").toString("utf8")
  if (!raw) problems.push("PREVIEW_GITHUB_APP_PRIVATE_KEY is missing")
  else if (!privateKey.startsWith("-----BEGIN")) problems.push("PREVIEW_GITHUB_APP_PRIVATE_KEY is neither a PEM nor base64 of one")
  if (problems.length) return { problems }
  return { appId, installationId, privateKey }
}

export function appJwt({ appId, privateKey }, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
  // iat is backdated by GitHub's recommended 60 s to absorb clock drift; the
  // token only has to outlive the installation-token exchange.
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 300, iss: appId })}`
  const signer = createSign("RSA-SHA256")
  signer.update(unsigned)
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`
}

// Notification errors must never turn a successful deployment into a failure.
export async function commentOnPreview({ env = process.env, urls, fetchImpl = fetch, warn = console.warn }) {
  const credentials = appCredentials(env)
  if (credentials.problems) {
    // Names only, never values: the build log is readable by the whole team.
    warn(`[preview-comment] Cannot publish QA links on PRs: ${credentials.problems.join("; ")}. Set the build variables on aquilla-web-preview.`)
    return
  }
  try {
    const { branch, commitSha } = workersBuildMetadata(env)
    if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error("invalid commit")
    const expected = `https://${workersBuildPreviewAlias(branch)}-aquilla-web-preview.blue-darkness-7674.workers.dev`
    if (urls.web !== expected) throw new Error("invalid preview URL")
    // One deadline bounds pagination and all network calls combined.
    const signal = AbortSignal.timeout(30_000)
    const request = async (path, bearer, method = "GET", body) => {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        method, signal, redirect: "error",
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      // Never log response bodies or transport errors: they may contain secrets.
      if (!response.ok) throw new Error("GitHub request failed")
      return response.json()
    }
    // Ask for the narrowest token the job needs, whatever the App itself holds.
    const issued = await request(`/app/installations/${credentials.installationId}/access_tokens`, appJwt(credentials), "POST", {
      permissions: { pull_requests: "write" },
    })
    if (typeof issued.token !== "string" || !issued.token) throw new Error("invalid installation token")
    const api = (path, method, body) => request(path, issued.token, method, body)
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
    const body = `${MARKER}\n## QA preview\n\n[**Open preview**](${urls.web})\n\nDeployed commit: [\`${commitSha.slice(0, 8)}\`](https://github.com/${REPO}/commit/${commitSha}).\n\n[Build status and logs](https://github.com/${REPO}/commit/${commitSha}/checks). This link serves the latest successful deployment of this branch; compare the deployed commit with the PR before testing.\n\nUses shared development data. Email and optional AI integrations require preview credentials.`
    for (const pr of prs.filter(matches)) {
      if (!Number.isSafeInteger(pr.number)) continue
      const comments = await list(`/repos/${REPO}/issues/${pr.number}/comments`)
      // An installation token cannot ask GitHub who it is, so the App's own
      // comments are recognised by the App id GitHub stamps on them.
      const existing = comments.find((comment) => comment.performed_via_github_app?.id === credentials.appId
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
    warn("[preview-comment] GitHub notification failed; deployment succeeded. Check the App credentials and installation, then retry the build.")
  }
}
