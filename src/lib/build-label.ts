// Rendering of the build identity shown in the version footer (AQU-1023).
// The values themselves are baked in at compile time by scripts/build-info.ts.

export type BuildIdentity = {
  version: string
  branch: string
  sha: string
  /** ISO-8601 instant of the build's commit; "" when unresolved. */
  builtAt: string
}

/**
 * Calendar day of the build in UTC (`YYYY-MM-DD`), so the same build reads the
 * same on every screenshot regardless of the viewer's locale or timezone.
 * Returns "" for a missing or unparseable timestamp.
 */
export function formatBuildDay(builtAt: string): string {
  if (!builtAt) return ""
  const parsed = new Date(builtAt)
  if (Number.isNaN(parsed.getTime())) return ""
  return parsed.toISOString().slice(0, 10)
}

/**
 * One-line build label. The date sits next to the hash so support can date a
 * build straight off a screenshot instead of resolving the hash. Branch is
 * dropped on the production line, where it's noise.
 */
export function formatBuildLabel({ version, branch, sha, builtAt }: BuildIdentity): string {
  const isProd = branch === "main" || branch === "production"
  return [`v${version}`, isProd ? "" : branch, sha, formatBuildDay(builtAt)]
    .filter(Boolean)
    .join(" · ")
}

/** Copyable/hoverable detail: the label plus the exact build coordinates. */
export function formatBuildInfo(identity: BuildIdentity): string {
  const lines = [formatBuildLabel(identity), `build: ${identity.branch}@${identity.sha}`]
  if (identity.builtAt) lines.push(`date: ${identity.builtAt}`)
  return lines.join("\n")
}
