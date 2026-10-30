export const HOLD_NUDGE_HOURS: number

// A release branch is release/YYYY/MM/DD, optionally with a same-day -NN
// suffix for the Nth slice cut that date (NN starts at 01).
export function isReleaseBranch(name: string): boolean

import type { FileClassification } from "./release-risk.mjs"

export type { FileClassification }
/** Re-exported from release-risk.mjs, where the file map lives. */
export function classifyFiles(files: Iterable<string>): FileClassification

/** One merged-but-unreleased PR on origin/dev, as listed in the release plan. */
export interface UnreleasedPr extends FileClassification {
  number: number
  sha: string
  /** ISO-8601 commit date of the merge. */
  mergedAt: string
  /** PASS | FAIL | FLAKY | BLOCKED | "none" (no UI claim) | "unknown" (not yet looked up). */
  walk: string
  /**
   * True when production already runs a dev commit newer than this PR (a
   * hotfix picked ahead of it), so the smallest cut that ships it is at the
   * floor. Such PRs are always a prefix of the list.
   */
  behindFloor?: boolean
  /** True when the PR carries the `release:approved` label (a person's sign-off). */
  approved?: boolean
}

/** Off the automatic line: paths hold or the walk is unproven, unless a person approved it. */
export function prHolds(pr: Pick<UnreleasedPr, "pathHolds" | "walk" | "approved">): boolean

/** Why a held PR is held, for the notes: "touches <areas>" or "walk <verdict>". */
export function holdReason(pr: Pick<UnreleasedPr, "pathHolds" | "walk" | "areas">): string

// A PR whose diff touches only docs, only test/journey files, or only
// allowlisted tooling scripts (release-plan*, qa/, smart-test*, e2e-*) has no
// UI claim, so the bot skips the walk entirely. There is no walk comment to
// look up, and there never will be one. An infra-area script still holds via
// pathHolds regardless.
export function isDocsOrTestOnly(files: string[]): boolean

/** One first-parent commit as the planner reads it out of `git log`. */
export interface LogEntry {
  sha: string
  /** ISO-8601 commit date. */
  mergedAt: string
  subject: string
  /** Commit body (%b): where a pick's `(cherry picked from commit <sha>)` line lives. */
  body: string
}

/** The PR a first-parent subject stands for (`Merge pull request #N`, or a squash `(#N)` suffix), if any. */
export function prNumberFromSubject(subject: string): number | undefined

/** What a tagged release tip proves it carries from dev. */
export interface ReleasedMarks {
  /** Dev merge shas named by `(cherry picked from commit <sha>)` lines on the tip. */
  shas: Set<string>
  /** PR numbers from the tip's own `Merge pull request #N` / `(#N)` subjects. */
  numbers: Set<number>
}

/** Reads the marks off the tip's first-parent commits that are not on dev (`origin/dev..<tag>`). */
export function releasedMarks(tagEntries: Pick<LogEntry, "subject" | "body">[]): ReleasedMarks

/**
 * Splits dev's first-parent commits above the cut point, oldest first, into
 * the ones the tip already carries and the ones still waiting. `floor` is the
 * newest dev commit production runs: the cut point, or the newest picked one.
 */
export function splitReleased<T extends Pick<LogEntry, "sha" | "subject">>(input: {
  devEntries: T[]
  marks: ReleasedMarks
  /** merge-base of the tagged tip and origin/dev. */
  cutPoint: string
}): { unreleased: (T & { behindFloor: boolean })[]; floor: string }

/**
 * Every PR merged to dev that production does not run yet, oldest first,
 * measured from the newest calver tag (origin/main before the first one).
 * Runs git in `cwd` (the process cwd by default).
 */
export function unreleasedPrs(opts?: { cwd?: string }): { prs: UnreleasedPr[]; floor: string; base: string }

/** A held PR as the plan reports it. */
export type HeldPr = Omit<UnreleasedPr, "pathHolds" | "behindFloor"> & { why: string }

export interface ReleasePlan {
  openReleases: string[]
  prCount: number
  /** The tagged tip production runs; the cut branch starts here and picks `prs` onto it. */
  base?: string
  cut: boolean
  reason: string
  /** Only present when cut is true. */
  branch?: string
  /** Set by release-cut.mjs once the picks are built; absent in the plan itself. */
  sha?: string
  areas?: string[]
  /** Ready PRs, oldest first: the ones the cut picks. */
  prs: Omit<UnreleasedPr, "pathHolds" | "behindFloor">[]
  /** PRs skipped by this cut, with why; they wait for `release:approved`. */
  held: HeldPr[]
}

export function planRelease(input: {
  openReleases: string[]
  prs: UnreleasedPr[]
  /** ISO-8601 timestamp used to name a newly cut branch. */
  now: string
  /** Same-day suffixes already in use, e.g. ["01", "02"]. */
  usedSuffixesToday?: string[]
  /** See ReleasePlan.base. */
  base?: string
}): ReleasePlan
