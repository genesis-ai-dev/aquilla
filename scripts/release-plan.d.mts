export const BATCH_SIZE: number
export const MAX_WAIT_HOURS: number

export type RiskTier = "low" | "high"

/** Path-based risk classification of one PR's changed files. */
export interface FileClassification {
  tier: RiskTier
  /** High-risk areas touched (e.g. "migration", "sync", "auth", "infra"), sorted. */
  areas: string[]
}

export function classifyFiles(files: Iterable<string>): FileClassification

/** One merged-but-unreleased PR on origin/dev, as listed in the release plan. */
export interface UnreleasedPr extends FileClassification {
  number: number
  sha: string
  /** ISO-8601 commit date of the merge. */
  mergedAt: string
}

export interface ReleasePlan {
  openReleases: string[]
  prCount: number
  tier: RiskTier
  prs: UnreleasedPr[]
  cut: boolean
  reason: string
}

export function planRelease(input: {
  openReleases: string[]
  prs: UnreleasedPr[]
  /** ISO-8601 timestamp the wait is measured against. */
  now: string
}): ReleasePlan
