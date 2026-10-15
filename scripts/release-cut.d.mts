import type { ReleasePlan, UnreleasedPr } from "./release-plan.mjs"

/**
 * The slice of a release plan the notes are rendered from. Narrower than
 * ReleasePlan so a test can hand in just these fields.
 */
export type ReleaseNotesPlan = Pick<ReleasePlan, "hold" | "reason" | "branch" | "areas"> & {
  prs: Pick<UnreleasedPr, "number" | "walk" | "areas">[]
}

// DEPLOY-BOT.md "Release notes template". titles maps PR number to title; a
// missing title prints as "(title unavailable)" rather than failing the cut.
export function releaseNotes(plan: ReleaseNotesPlan, titles?: Partial<Record<number, string>>): string
