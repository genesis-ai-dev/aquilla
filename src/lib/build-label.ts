// Rendering of the build identity shown in the version footer (AQU-1023).
// The values themselves are baked in at compile time by scripts/build-info.ts.

export type BuildIdentity = {
  version: string
  branch: string
  sha: string
  /** ISO-8601 instant of the build's commit; "" when unresolved. */
  builtAt: string
  /**
   * Desktop only: the web bundle the shell is serving (a release calver once a
   * hot bundle has downloaded). Absent on the web, where the sha is the build.
   */
  bundle?: string
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

/**
 * AQU-1523: the variant for a fixed-width left rail, which drops the branch in
 * every environment rather than only on production.
 *
 * `formatBuildLabel` already treats the branch as the expendable field (it is
 * "noise" on the production line). In a 224px sidebar it is expendable
 * everywhere: at the footer's 10px monospace a glyph is ~6.5px, so the full
 * four-field label needs ~228px on `dev` and far more on a preview build named
 * after its PR branch — more than the row has, which is how the label came to
 * render as `v0`. Version, sha and date are what support reads off a
 * screenshot; the branch stays in the hover tooltip and the copy payload
 * (`formatBuildInfo`), which are not width-bound.
 */
export function formatBuildRailLabel({ version, sha, builtAt }: BuildIdentity): string {
  return [`v${version}`, sha, formatBuildDay(builtAt)].filter(Boolean).join(" · ")
}

/** Copyable/hoverable detail: the label plus the exact build coordinates. */
export function formatBuildInfo(identity: BuildIdentity): string {
  const lines = [formatBuildLabel(identity), `build: ${identity.branch}@${identity.sha}`]
  if (identity.builtAt) lines.push(`date: ${identity.builtAt}`)
  // A shell still on its embedded assets reports its own version as the bundle;
  // repeating the number on a second line would read as two different things.
  const { bundle, version } = identity
  if (bundle && bundle !== version && bundle !== `v${version}`) lines.push(`bundle: ${bundle}`)
  return lines.join("\n")
}
