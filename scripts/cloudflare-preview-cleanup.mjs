// Sweeps Cloudflare Previews whose git branch no longer exists, so that the
// Durable Object namespaces Cloudflare provisions per Preview are released.
//
// Why: every `wrangler preview` of aquilla-sync-preview gets its own ProjectSync
// and FileSync namespaces (that is how Previews isolate DO state), and nothing
// deleted them when a branch was merged. The account hit Cloudflare's cap of 500
// namespaces on 2026-09-23 and every preview deploy failed with code 10067
// (AQU-1396). Cloudflare documents that a Preview's DO storage "is deleted when
// the Preview is deleted", so deleting stale Previews is the release.
//
// Runs from scripts/cloudflare-stack-preview.mjs on every branch build, before
// the branch's own Previews are created. This repo deliberately runs no
// pull_request GitHub Actions (AQU-564), so Cloudflare's "delete on PR close"
// recipe does not apply here.
//
// Manual use (needs CLOUDFLARE_API_TOKEN with Workers Scripts edit):
//   node scripts/cloudflare-preview-cleanup.mjs --dry-run
//   node scripts/cloudflare-preview-cleanup.mjs [--branch=<branch-to-keep>]
import { execFile } from "node:child_process"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"
import { appCredentials, appJwt } from "./cloudflare-preview-comment.mjs"

export const ACCOUNT_ID = "6a80496d1e59948a9cbaa3c643ba81d7"
// Sync first: that is the Worker whose Previews own Durable Object namespaces.
export const PREVIEW_WORKER_NAMES = ["aquilla-sync-preview", "aquilla-auth-preview", "aquilla-web-preview"]
export const DEFAULT_IDLE_DAYS = 14
export const MAX_DELETIONS_PER_WORKER = 300
const REPO = "genesis-ai-dev/aquilla"
const GITHUB_API_VERSION = "2026-03-10"
// Only names this repo's deploy script produces (workersBuildPreviewAlias):
// anything else was created by a person and is not ours to remove.
const CI_ALIAS = /^ci-[a-z0-9-]*-[a-f0-9]{8}$/
const DAY = 86_400_000
const execFileAsync = promisify(execFile)
const timeoutSignal = (ms) => (typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined)

export function previewLastActivity(preview) {
  const value = preview.deployed_on ?? preview.updated_on ?? preview.created_on
  return value ? Date.parse(value) : NaN
}

// Pure policy. With a live-branch set, a ci-* preview is stale exactly when its
// branch is gone; age never removes a live branch's preview. Without one, only
// the idle rule applies, because sweeping a live branch's preview by mistake
// costs a reviewer their QA link. Oldest first, capped per run.
export function selectStalePreviews({
  previews, currentAlias = null, liveAliases = null, now = Date.now(),
  idleDays = DEFAULT_IDLE_DAYS, limit = MAX_DELETIONS_PER_WORKER,
}) {
  const stale = []
  const kept = { current: 0, foreign: 0, live: 0, fresh: 0 }
  for (const preview of previews) {
    const name = String(preview.name ?? "")
    if (currentAlias && name === currentAlias) { kept.current += 1; continue }
    if (!CI_ALIAS.test(name)) { kept.foreign += 1; continue }
    const lastActivity = previewLastActivity(preview)
    if (liveAliases) {
      if (liveAliases.has(name)) { kept.live += 1; continue }
      stale.push({ name, reason: "branch deleted", lastActivity })
      continue
    }
    const idle = now - lastActivity
    if (!(idle > idleDays * DAY)) { kept.fresh += 1; continue } // NaN keeps
    stale.push({ name, reason: `idle ${Math.floor(idle / DAY)}d`, lastActivity })
  }
  const order = (value) => (Number.isNaN(value) ? Infinity : value)
  stale.sort((a, b) => order(a.lastActivity) - order(b.lastActivity))
  return { stale: stale.slice(0, limit), deferred: Math.max(0, stale.length - limit), kept }
}

// Branch liveness: the build's own clone first, then the QA GitHub App that
// already posts preview comments (repository metadata read is implicit for every
// installation, which is all branch listing needs). null means "unknown".
export async function liveBranchAliases({ cwd = process.cwd(), env = process.env, exec = execFileAsync, fetchImpl = fetch } = {}) {
  try {
    const { stdout } = await exec("git", ["ls-remote", "--heads", "--quiet", "origin"], {
      cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })
    const branches = String(stdout).split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((ref) => ref?.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length))
    if (branches.length) return { source: "git", aliases: new Set(branches.map(workersBuildPreviewAlias)) }
  } catch { /* the clone may have no usable remote; try GitHub */ }
  const credentials = appCredentials(env)
  if (!credentials.problems) {
    try {
      const signal = timeoutSignal(60_000)
      const request = async (path, bearer, method = "GET", body) => {
        const response = await fetchImpl(`https://api.github.com${path}`, {
          method, signal, redirect: "error",
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!response.ok) throw new Error(`GitHub ${method} ${path} answered HTTP ${response.status}`)
        return response.json()
      }
      const issued = await request(`/app/installations/${credentials.installationId}/access_tokens`, appJwt(credentials), "POST", {
        permissions: { metadata: "read" },
      })
      if (typeof issued.token !== "string" || !issued.token) throw new Error("invalid installation token")
      const branches = []
      for (let page = 1; page <= 20; page += 1) {
        const rows = await request(`/repos/${REPO}/branches?per_page=100&page=${page}`, issued.token)
        if (!Array.isArray(rows)) throw new Error("invalid branches response")
        branches.push(...rows.map((row) => row?.name).filter((name) => typeof name === "string" && name))
        if (rows.length < 100) break
      }
      if (branches.length) return { source: "github", aliases: new Set(branches.map(workersBuildPreviewAlias)) }
    } catch { /* fall back to the idle rule */ }
  }
  return { source: null, aliases: null }
}

async function mapLimit(items, limit, task) {
  const queue = [...items]
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await task(queue.shift())
  })
  await Promise.all(lanes)
}

export async function cleanupStalePreviews({
  cwd = process.cwd(), env = process.env, currentAlias = null, workers = PREVIEW_WORKER_NAMES,
  fetchImpl = fetch, exec, now = Date.now(), dryRun = false, concurrency = 4,
  log = console.log, warn = console.warn,
} = {}) {
  if (/^(0|false|off|no)$/i.test(String(env.PREVIEW_CLEANUP ?? "").trim())) {
    log("[preview-cleanup] disabled by PREVIEW_CLEANUP; stale previews were not swept")
    return { skipped: "disabled", workers: [] }
  }
  // Wrangler itself reads these names in the build, so whatever authenticated
  // `wrangler preview` authenticates this. Never log the value.
  const token = env.CLOUDFLARE_API_TOKEN?.trim() || env.CF_API_TOKEN?.trim()
  if (!token) {
    warn("[preview-cleanup] CLOUDFLARE_API_TOKEN is not set in this build; stale previews were not swept")
    return { skipped: "no-token", workers: [] }
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || env.CF_ACCOUNT_ID?.trim() || ACCOUNT_ID
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("invalid Cloudflare account id")
  const api = (path, method = "GET") => fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    method, redirect: "error", signal: timeoutSignal(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
  const listPreviews = async (worker) => {
    const previews = []
    for (let page = 1; page <= 50; page += 1) {
      const response = await api(`/accounts/${accountId}/workers/workers/${worker}/previews?per_page=100&page=${page}`)
      if (!response.ok) throw new Error(`listing ${worker} previews answered HTTP ${response.status}`)
      const body = await response.json()
      const rows = Array.isArray(body?.result) ? body.result : null
      if (!rows) throw new Error(`listing ${worker} previews returned no result array`)
      previews.push(...rows)
      if (rows.length < 100) break
    }
    return previews
  }

  const live = await liveBranchAliases({ cwd, env, exec, fetchImpl })
  if (!live.aliases) {
    warn(`[preview-cleanup] could not list origin branches via git or GitHub; only previews idle ${DEFAULT_IDLE_DAYS}+ days will be swept`)
  }
  const results = []
  for (const worker of workers) {
    const previews = await listPreviews(worker)
    const { stale, deferred, kept } = selectStalePreviews({ previews, currentAlias, liveAliases: live.aliases, now })
    let deleted = 0
    let failed = 0
    await mapLimit(stale, concurrency, async (preview) => {
      if (dryRun) {
        log(`[preview-cleanup] would delete ${worker}/${preview.name} (${preview.reason})`)
        return
      }
      try {
        const response = await api(`/accounts/${accountId}/workers/workers/${worker}/previews/${encodeURIComponent(preview.name)}`, "DELETE")
        // 404: another build swept it first. The namespace is gone either way.
        if (response.ok || response.status === 404) { deleted += 1; return }
        throw new Error(`HTTP ${response.status}`)
      } catch (error) {
        failed += 1
        warn(`[preview-cleanup] ${worker}/${preview.name}: delete failed (${error instanceof Error ? error.message : String(error)})`)
      }
    })
    const basis = live.source ? `branch gone per ${live.source}` : `idle ${DEFAULT_IDLE_DAYS}d+ fallback`
    const verb = dryRun ? `would delete ${stale.length}` : `deleted ${deleted}, failed ${failed}`
    log(`[preview-cleanup] ${worker}: ${previews.length} previews, ${stale.length} stale (${basis}); ${verb}; kept ${kept.live} live, ${kept.current} current, ${kept.foreign} foreign, ${kept.fresh} fresh${deferred ? `; ${deferred} deferred to the next build` : ""}`)
    results.push({ worker, total: previews.length, stale: stale.length, deleted, failed, deferred, kept })
  }
  return { source: live.source, dryRun, workers: results }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes("--dry-run")
  const branchArg = process.argv.find((arg) => arg.startsWith("--branch="))
  cleanupStalePreviews({ dryRun, currentAlias: branchArg ? workersBuildPreviewAlias(branchArg.slice("--branch=".length)) : null })
    .then((result) => { if (result.skipped) process.exitCode = 1 })
    .catch((error) => {
      console.error(`[preview-cleanup] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
