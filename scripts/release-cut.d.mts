import type { HeldPr, ReleasePlan, UnreleasedPr } from "./release-plan.mjs"

/**
 * The slice of a release plan the notes are rendered from. Narrower than
 * ReleasePlan so a test can hand in just these fields.
 */
export type ReleaseNotesPlan = Pick<ReleasePlan, "branch" | "areas"> & {
  prs: Pick<UnreleasedPr, "number" | "walk" | "areas">[]
  held?: Pick<HeldPr, "number" | "why">[]
}

// RELEASE-CUT.md "Release notes template". titles maps PR number to title; a
// missing title prints as "(title unavailable)" rather than failing the cut.
export function releaseNotes(plan: ReleaseNotesPlan, titles?: Partial<Record<number, string>>): string

/** What the cut needs of a PR: to pick it, and to explain a pick that did not land. */
export type PickCandidate = Pick<UnreleasedPr, "number" | "sha"> & Partial<Pick<UnreleasedPr, "mergedAt" | "files">>

/** A ready PR this cut could not pick, filed as held with why. */
export type UnpickedPr<T> = T & {
  /** `conflict`: git stopped on unmerged paths. `empty`: the pick had nothing to commit. */
  kind: "conflict" | "empty"
  /** The unmerged paths of a conflict; empty for an empty pick. */
  paths: string[]
  /** The held PR the pick most likely needs (dependencyHint), when the plan's files show one. */
  needs?: number
  /** The held-line reason: `pick conflict in <paths>; needs #N` or `empty pick: already in base, or needs #N`. */
  why: string
}

/**
 * The held PR a pick most likely needs: the newest candidate merged before
 * `pr` whose files touch one of `paths`; undefined when none does or the
 * plan carries no files.
 */
export function dependencyHint(pr: PickCandidate, paths: string[], candidates: PickCandidate[]): number | undefined

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

/** One `- #N: <why>` line per unpicked PR. */
export function unpickedReport(unpicked: { number: number; why: string }[]): string

/** The run summary's opening: what the cut landed and, per unpicked PR, why it did not. */
export function cutSummary(
  plan: { branch?: string; base?: string; prs: unknown[] },
  built: { sha: string; picked: unknown[]; unpicked: { number: number; why: string }[] },
): string
