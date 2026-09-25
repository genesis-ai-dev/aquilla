export const HOLD_NUDGE_HOURS: number

// A release branch is release/YYYY/MM/DD, optionally with a same-day -NN
// suffix for the Nth slice cut that date (NN starts at 01).
export function isReleaseBranch(name: string): boolean

/** Path-based risk classification of one PR's changed files. */
export interface FileClassification {
  /** Areas touched (e.g. "migration", "sync", "auth", "infra"), sorted. */
  areas: string[]
  /** True when the PR touches a migration or the deploy machinery itself. */
  pathHolds: boolean
}

export function classifyFiles(files: Iterable<string>): FileClassification

/** One merged-but-unreleased PR on origin/dev, as listed in the release plan. */
export interface UnreleasedPr extends FileClassification {
  number: number
  sha: string
  /** ISO-8601 commit date of the merge. */
  mergedAt: string
  /** PASS | FAIL | FLAKY | BLOCKED | "none" (no UI claim) | "unknown" (not yet looked up). */
  walk: string
}

export function prHolds(pr: Pick<UnreleasedPr, "pathHolds" | "walk">): boolean

// A PR whose diff touches only docs or only test/journey files has no UI
// claim, so the bot skips the walk entirely — there is no walk comment to
// look up, and there never will be one.
export function isDocsOrTestOnly(files: string[]): boolean

export interface ReleasePlan {
  openReleases: string[]
  prCount: number
  cut: boolean
  reason: string
  /** True when the cut slice needs a human gate before it deploys. */
  hold: boolean
  /** Only present when cut is true. */
  branch?: string
  sha?: string
  areas?: string[]
  prs: Omit<UnreleasedPr, "pathHolds">[]
}

export function planRelease(input: {
  openReleases: string[]
  prs: UnreleasedPr[]
  /** ISO-8601 timestamp used to name a newly cut branch. */
  now: string
  /** Same-day suffixes already in use, e.g. ["01", "02"]. */
  usedSuffixesToday?: string[]
}): ReleasePlan
