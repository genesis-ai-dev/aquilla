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

/** Picks each PR onto a new branch at base; a conflicting pick is aborted and reported, not fatal. */
export function buildReleaseBranch<T extends { sha: string }>(input: {
  branch: string
  base: string
  prs: T[]
  /** Repo to run git in; the process cwd by default. */
  cwd?: string
}): { sha: string; picked: T[]; conflicts: (T & { why: string })[] }
