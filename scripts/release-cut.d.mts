import type { HeldPr, ReleasePlan, UnreleasedPr } from "./release-plan.mjs"

/**
 * The slice of a release plan the notes are rendered from. Narrower than
 * ReleasePlan so a test can hand in just these fields.
 */
export type ReleaseNotesPlan = Pick<ReleasePlan, "branch" | "areas"> & {
  prs: (Pick<UnreleasedPr, "walk" | "areas"> & EntryName)[]
  held?: (Pick<HeldPr, "why"> & EntryName)[]
}

/**
 * What names an entry to a person: a PR's `number`, or a direct commit's
 * `direct` flag with its `sha` and `subject`.
 */
export type EntryName = Partial<Pick<UnreleasedPr, "number" | "direct" | "sha" | "subject">>

/** The sentence the notes add when a direct commit is held as "not a PR": pick it by hand with -x. */
export const DIRECT_HELD_NOTE: string

// RELEASE-CUT.md "Release notes template". titles maps PR number to title; a
// missing title prints as "(title unavailable)" rather than failing the cut.
// A direct commit's row is its short sha and its own subject.
export function releaseNotes(plan: ReleaseNotesPlan, titles?: Partial<Record<number, string>>): string

/** What the cut needs of a PR or a direct commit: to pick it, and to explain a pick that did not land. */
export type PickCandidate = Pick<UnreleasedPr, "sha"> &
  Partial<Pick<UnreleasedPr, "number" | "direct" | "subject" | "mergedAt" | "files">>

/** A ready PR this cut could not pick, filed as held with why. */
export type UnpickedPr<T> = T & {
  /** `conflict`: git stopped on unmerged paths. `empty`: the pick had nothing to commit. */
  kind: "conflict" | "empty"
  /** The unmerged paths of a conflict; empty for an empty pick. */
  paths: string[]
  /**
   * What the pick most likely needs (dependencyHint), when the plan's files
   * show one: a held PR's number, or a held direct commit's short sha.
   */
  needs?: number | string
  /**
   * The held-line reason: `pick conflict in <paths>; needs #N` or `empty pick:
   * already in base, or needs #N`, with `direct commit <sha>` in place of
   * `#N` when what it needs is a direct commit.
   */
  why: string
}

/**
 * What a pick most likely needs: the newest candidate merged before `pr`
 * whose files touch one of `paths`, as a PR number or, for a direct commit,
 * its short sha; undefined when none does or the plan carries no files.
 */
export function dependencyHint(pr: PickCandidate, paths: string[], candidates: PickCandidate[]): number | string | undefined

/**
 * Picks each PR onto a new branch at base. A conflicting pick is aborted and
 * an empty one skipped; both are reported as unpicked, never fatal.
 */
export function buildReleaseBranch<T extends PickCandidate>(input: {
  branch: string
  base: string
  prs: T[]
  /** The plan's held PRs, with files: the candidates for `needs`. */
  held?: PickCandidate[]
  /** Repo to run git in; the process cwd by default. */
  cwd?: string
}): { sha: string; picked: T[]; unpicked: UnpickedPr<T>[] }

/** One `- #N: <why>` line per unpicked PR; a direct commit is `- <short sha> "<subject>": <why>`. */
export function unpickedReport(unpicked: (EntryName & { why: string })[]): string

/** The run summary of a plan that cuts nothing: the reason, then every direct commit the plan holds. */
export function noCutSummary(plan: Pick<ReleasePlan, "reason"> & { held?: (EntryName & { why: string })[] }): string

/** The run summary's opening: what the cut landed and, per unpicked PR, why it did not. */
export function cutSummary(
  plan: { branch?: string; base?: string; prs: EntryName[] },
  built: { sha: string; picked: unknown[]; unpicked: (EntryName & { why: string })[] },
): string
