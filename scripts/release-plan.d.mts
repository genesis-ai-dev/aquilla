export const HOLD_NUDGE_HOURS: number

// A release branch is release/YYYY/MM/DD, optionally with a same-day -NN
// suffix for the Nth slice cut that date (NN starts at 01).
export function isReleaseBranch(name: string): boolean

import type { FileClassification } from "./release-risk.mjs"

export type { FileClassification }
/** Re-exported from release-risk.mjs, where the file map lives. */
export function classifyFiles(files: Iterable<string>): FileClassification

/**
 * One unreleased first-parent commit on origin/dev, as listed in the release
 * plan: a merged PR, or a direct commit (pushed to dev with no PR), which
 * carries `direct` and `subject` and no `number`.
 */
export interface UnreleasedPr extends FileClassification {
  /** The PR number. Absent on a direct commit. */
  number?: number
  /** True for a commit pushed straight to dev with no PR. */
  direct?: boolean
  /** The commit subject. Carried for a direct commit, which has no PR title to fetch. */
  subject?: string
  sha: string
  /** ISO-8601 commit date of the merge. */
  mergedAt: string
  /**
   * PASS | FAIL | FLAKY | BLOCKED | "none" (no UI claim) | "unknown" (not yet looked up).
   * A direct commit is never walked: "none" when it only touches locale
   * catalogs, "unknown" otherwise.
   */
  walk: string
  /**
   * True when production already runs a dev commit newer than this PR (a
   * hotfix picked ahead of it), so the smallest cut that ships it is at the
   * floor. Such PRs are always a prefix of the list.
   */
  behindFloor?: boolean
  /** True when the PR carries the `release:approved` label (a person's sign-off). */
  approved?: boolean
  /** Areas whose gate check (release-risk.mjs AREA_GATES) passed on the PR's head. */
  gates?: string[]
  /**
   * Every path the merged diff touches (first parent → merge commit), as
   * classified. The cut reads these to name the held PR a pick that did
   * not land was built on; absent only in a hand-built plan.
   */
  files?: string[]
}

/** How a walk verdict is read: `fail-only` holds only a failed walk, `strict` anything but PASS or none. */
export type WalkPolicy = "fail-only" | "strict"
export const WALK_POLICIES: WalkPolicy[]
export const DEFAULT_WALK_POLICY: WalkPolicy

/** The policy named by WALK_POLICY in `env`, or the default. */
export function walkPolicy(env?: Record<string, string | undefined>): WalkPolicy

/** Whether this walk verdict keeps a PR off the line under `policy`. */
export function walkHolds(walk: string, policy?: WalkPolicy): boolean

/**
 * Off the automatic line: an ungated holding area or a walk that holds under
 * `policy`, unless a person approved it. A direct commit holds unless every
 * file it touches is a generated locale catalog; no walk, gate or label is
 * read for it.
 */
export function prHolds(pr: Pick<UnreleasedPr, "areas" | "walk" | "approved" | "gates" | "direct" | "files">, policy?: WalkPolicy): boolean

/** The hold reason of a direct commit the line does not pick by itself. */
export const NOT_A_PR: string

/**
 * Why a held PR is held, for the notes: "touches <areas>" or "walk <verdict>".
 * A direct commit: "not a PR", with "; touches <areas>" when it has holding areas.
 */
export function holdReason(pr: Pick<UnreleasedPr, "walk" | "areas" | "gates" | "direct">): string

// A PR whose diff touches only docs, only test/journey files, or only
// allowlisted tooling scripts (release-plan*, qa/, smart-test*, e2e-*) has no
// UI claim, so the bot skips the walk entirely. There is no walk comment to
// look up, and there never will be one. An infra-area script still holds via
// pathHolds regardless.
export function isDocsOrTestOnly(files: string[]): boolean

/**
 * True when every file is a generated locale catalog
 * (`src/lib/i18n/messages/<locale>.ts`, never `en.ts`, `index.ts` or `all.ts`)
 * or the source-hash sidecar and translation baseline beside them. The one kind of direct commit the
 * release line picks without a person.
 */
export function isLocaleCatalogOnly(files: string[]): boolean

/** How an entry is named to a person: `#N` for a PR, the short dev sha for a direct commit. */
export function entryLabel(entry: Pick<UnreleasedPr, "number" | "direct"> & { sha?: string }): string

/** "3 PR(s)", or "3 PR(s) and 1 direct commit(s)"; `adjective` goes before "PR(s)". */
export function tally(entries: Pick<UnreleasedPr, "direct">[], adjective?: string): string

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
 * Every first-parent commit on dev that production does not run yet, oldest
 * first, measured from the newest calver tag (origin/main before the first
 * one): the merged PRs and, in their dev position, the direct commits. Only
 * a direct commit that changes no file is left out. Runs git in `cwd` (the
 * process cwd by default).
 */
export function unreleasedPrs(opts?: { cwd?: string }): { prs: UnreleasedPr[]; floor: string; base: string }

/** A held PR as the plan reports it. */
export type HeldPr = Omit<UnreleasedPr, "pathHolds" | "behindFloor"> & { why: string }

export interface ReleasePlan {
  openReleases: string[]
  /** Unreleased PRs on dev at plan time, ready and held. */
  prCount: number
  /** Unreleased direct commits on dev at plan time, ready and held. */
  directCount: number
  /** The tagged tip production runs; the cut branch starts here and picks `prs` onto it. */
  base?: string
  cut: boolean
  reason: string
  /** Only present when cut is true. */
  branch?: string
  /** Set by release-cut.mjs once the picks are built; absent in the plan itself. */
  sha?: string
  areas?: string[]
  /** Ready PRs and ready direct commits, in dev order, oldest first: what the cut picks. */
  prs: Omit<UnreleasedPr, "pathHolds" | "behindFloor">[]
  /**
   * Entries off the line, with why, on every plan (cut or not). A PR waits
   * for a gate or `release:approved`; a direct commit waits for a person to
   * pick it onto a release branch.
   */
  held: HeldPr[]
  /** The walk policy the plan was made under. */
  walkPolicy?: WalkPolicy
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
  policy?: WalkPolicy
}): ReleasePlan
