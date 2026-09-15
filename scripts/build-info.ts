// Build identity baked into the SPA at compile time (AQU-1023).
//
// Production builds run under **Cloudflare Workers Builds**, which exports
// WORKERS_CI_BRANCH / WORKERS_CI_COMMIT_SHA (see scripts/assert-workers-build-env.mjs)
// and checks the repo out at a **detached HEAD**. `git rev-parse --abbrev-ref HEAD`
// therefore returns the literal string "HEAD" there, which is what the version
// footer was rendering instead of a branch name. CF_PAGES_* only ever existed on
// Cloudflare Pages, which this repo no longer deploys to.
//
// These resolvers are pure so vite.config.ts stays a thin wrapper over tested logic.

export type BuildEnv = Record<string, string | undefined>

/** Placeholder used whenever a value can't be resolved from CI or git. */
export const UNKNOWN = "unknown"

/** `git rev-parse --abbrev-ref HEAD` yields this when the checkout is detached. */
const DETACHED_HEAD = "HEAD"

function firstNonEmpty(values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return ""
}

/**
 * Branch name for the build, in CI-precedence order. A detached-HEAD git answer
 * is discarded rather than shown — "unknown" is honest, "HEAD" is misleading.
 */
export function resolveBuildBranch(env: BuildEnv, gitBranch = ""): string {
  const fromGit = gitBranch.trim() === DETACHED_HEAD ? "" : gitBranch
  return (
    firstNonEmpty([
      env.WORKERS_CI_BRANCH,
      env.CF_PAGES_BRANCH,
      // GitHub Actions: HEAD_REF is set on pull_request runs (REF_NAME is the merge ref).
      env.GITHUB_HEAD_REF,
      env.GITHUB_REF_NAME,
      fromGit,
    ]) || UNKNOWN
  )
}

/** Short commit SHA for the build, in the same CI-precedence order. */
export function resolveBuildSha(env: BuildEnv, gitSha = ""): string {
  const sha = firstNonEmpty([
    env.WORKERS_CI_COMMIT_SHA,
    env.CF_PAGES_COMMIT_SHA,
    env.GITHUB_SHA,
    gitSha,
  ])
  return sha ? sha.slice(0, 7) : UNKNOWN
}

/**
 * When the build's commit was authored, as an ISO-8601 instant. The commit date
 * is what support actually needs — it maps the hash on a screenshot to a day —
 * so it wins over wall-clock build time, which only differs for rebuilds.
 */
export function resolveBuildDate(gitCommitDate = "", now: Date = new Date()): string {
  const commit = gitCommitDate.trim()
  if (commit) {
    const parsed = new Date(commit)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return now.toISOString()
}
