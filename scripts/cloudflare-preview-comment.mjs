import { createSign } from "node:crypto"

import { workersBuildMetadata } from "./assert-workers-build-env.mjs"
import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"

const REPO = "genesis-ai-dev/aquilla"
const MARKER = "<!-- aquilla-qa-preview -->"
const API_VERSION = "2026-03-10"
const MIGRATIONS_DIR = "db/postgres/migrations/"

// The comment is posted by the "Aquilla QA" GitHub App (aquilla-qa-bot), not
// by a person. The build holds the App's id, its installation id on this repo,
// and one of its private keys; the script proves it is the App by signing a
// short-lived JWT, then trades that for a one-hour installation token scoped
// to pull-request writes only.
// Each credential has one preferred build-variable name and short aliases the
// first setup used; the first name with a value wins.
const VARIABLES = {
  appId: ["PREVIEW_GITHUB_APP_ID", "APP_ID"],
  installationId: ["PREVIEW_GITHUB_APP_INSTALLATION_ID", "INSTALLATION_ID"],
  privateKey: ["PREVIEW_GITHUB_APP_PRIVATE_KEY", "PRIVATE_KEY"],
}

export function appCredentials(env = process.env) {
  const problems = []
  const read = (key) => {
    const name = VARIABLES[key].find((candidate) => env[candidate]?.trim()) ?? VARIABLES[key][0]
    return { name, value: env[name]?.trim() ?? "" }
  }
  const id = (key) => {
    const { name, value } = read(key)
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number <= 0) problems.push(`${name} ${value ? "is not a positive integer" : "is missing"}`)
    return number
  }
  const appId = id("appId")
  const installationId = id("installationId")
  // Cloudflare build variables do not reliably keep PEM line breaks, so the
  // key is stored base64-encoded. A raw PEM is accepted too.
  const key = read("privateKey")
  const privateKey = !key.value ? "" : key.value.startsWith("-----BEGIN") ? key.value : Buffer.from(key.value, "base64").toString("utf8")
  if (!key.value) problems.push(`${key.name} is missing`)
  else if (!privateKey.startsWith("-----BEGIN")) problems.push(`${key.name} is neither a PEM nor base64 of one`)
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

// AQU-1435: a preview runs branch code against shared development Postgres,
// and nothing migrates that database as part of the preview deploy. The real
// deploy path cannot drift this way — deploy:aquilla:dev:* chains
// `neon:status:dev`, which exits non-zero per pending migration — but the
// preview path has no equivalent gate and no database credentials to run one.
// What it can do is NAME the blocker instead of leaving QA to discover it as a
// bare 500: a migration file the PR adds is by definition not on `dev`, and
// development storage is only ever migrated from `dev`, so it is pending.
//
// `files` is GitHub's listing for the PR. A non-array (the call failed) is
// reported as unknown rather than as "none" — claiming a clean database we did
// not check is the one answer worse than saying nothing.
export function pendingMigrations(files) {
  if (!Array.isArray(files)) return null
  return files
    .filter((file) => typeof file?.filename === "string"
      && file.filename.startsWith(MIGRATIONS_DIR) && file.filename.endsWith(".sql")
      && file.status !== "removed")
    .map((file) => ({
      name: file.filename.slice(MIGRATIONS_DIR.length),
      status: typeof file.status === "string" && file.status ? file.status : "changed",
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function migrationNotice(pending) {
  if (!pending) {
    return "### Postgres migrations\n\nCould not read this PR's file list, so pending migrations are **unknown**. Before filing a 500 as a defect, check whether this branch adds anything under `db/postgres/migrations/` and whether `pnpm neon:status:dev` reports it pending."
  }
  if (!pending.length) {
    return "### Postgres migrations\n\nThis PR carries none, so pending schema is not a candidate explanation for anything that fails on this preview."
  }
  const rows = pending.map((file) => `- \`${file.name}\` (${file.status})`).join("\n")
  return `### Postgres migrations — PENDING on this preview\n\nPreviews share the development Hyperdrive database, which is migrated only from \`dev\` (by \`deploy:aquilla:dev:*\`, gated on \`neon:status:dev\`). These files are not on \`dev\`, so the preview's database does not yet have what they add:\n\n${rows}\n\nUntil an operator applies them (\`pnpm neon:apply:dev\`), every route that reads the new schema answers **500**, and a shared-path reader can take a whole API down rather than only the surface this PR touched. Read such a 500 as pending schema, not as a defect in the change.`
}

export function previewBody({ urls, commitSha, notice }) {
  return `${MARKER}\n## QA preview\n\n[**Open preview**](${urls.web})\n\nDeployed commit: [\`${commitSha.slice(0, 8)}\`](https://github.com/${REPO}/commit/${commitSha}).\n\n[Build status and logs](https://github.com/${REPO}/commit/${commitSha}/checks). This link serves the latest successful deployment of this branch; compare the deployed commit with the PR before testing.\n\n${notice}\n\n### Jev smart testing\n\nThis preview build does not run Jev. Look for a separate **Jev smart testing** comment matching the deployed commit. It reports setup, verified outcomes, failures, or inconclusive checks. No matching completed report means **NOT VERIFIED**.\n\n[Covered journeys and PR reporting command](https://github.com/${REPO}/blob/${commitSha}/smart-tests/README.md). The suite covers edit durability, project and file renaming, and cell comments on isolated synthetic data. A preview deployment is not a test pass.\n\nUses shared development data. Email and optional AI integrations require preview credentials.`
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
    for (const pr of prs.filter(matches)) {
      if (!Number.isSafeInteger(pr.number)) continue
      // AQU-1435 — which Postgres migrations this PR carries, so the comment can
      // say "0112 is pending" instead of letting QA meet it as an opaque 500.
      // The listing is per-PR, so the body is built per PR too. A failure here
      // must not cost QA the preview link: it degrades to "unknown".
      let files = null
      try {
        files = await list(`/repos/${REPO}/pulls/${pr.number}/files`)
      } catch {
        files = null
      }
      const pending = pendingMigrations(files)
      // Also in the build log, which is readable without the comment landing.
      if (pending?.length) {
        warn(`[preview-comment] PR #${pr.number}: ${pending.length} Postgres migration(s) are not on \`dev\` and so are pending on development storage: ${pending.map((file) => file.name).join(", ")}. Apply with \`pnpm neon:apply:dev\` before walking this preview.`)
      }
      const body = previewBody({ urls, commitSha, notice: migrationNotice(pending) })
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
