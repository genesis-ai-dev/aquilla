// Orthography exception list — the merge (AQU-2642 §4).
//
// The list of words a lane's spelling rules must LEAVE ALONE is a record of
// decisions: each entry says who asked for the word and whether a maintainer
// approved it. That is why it is written as a MERGE of add/remove decisions
// against the stored list rather than replaced wholesale — replacing it writes
// the writer's snapshot, so a decision someone else recorded between the read
// and the write disappears with nothing to say it did.
//
// Pure and dependency-free, with relative imports only and no DOM, so every
// surface that writes the list runs the SAME rule table: sync-worker's
// PatchOrthographyExceptions command (prepare preview, commit write and the
// supersede predicate) and, when it lands, the in-app "Add as exception" /
// "Propose exception" affordance beside Fix.
//
// Spec: aquilla-specs 04-features/checks-rules-and-living-memory.md
// (Fix-review → the exception list) and 04-features/project-settings.md
// (Concurrent edit detection → the merge carve-out).

import { foldExceptionWord, normalizeExceptionWord, type OrthographyException } from './orthography'

export const ORTHOGRAPHY_EXCEPTION_ACTIONS = ['add', 'remove'] as const
export type OrthographyExceptionAction = (typeof ORTHOGRAPHY_EXCEPTION_ACTIONS)[number]

/** One exception to add or remove. `word` is the word in the spelling the
 *  rules must NOT touch; `ref` is where it was found (a cell id, a verse
 *  reference, a note), carried onto the stored entry so the Language profile
 *  panel can show why it was asked for. */
export interface OrthographyExceptionOp {
  action: OrthographyExceptionAction
  word: string
  ref?: string
}

/** Most ops one write may carry (AQU-2642 §4). A bulk paste of a word list is
 *  the real use; above this it is a profile import, not a review decision. */
export const MAX_ORTHOGRAPHY_EXCEPTION_OPS = 200

/** What one op did to the list, for the approval page and the receipt. */
export type OrthographyExceptionEffect =
  | 'added'
  | 'approved'
  | 'removed'
  | 'already-approved'
  | 'already-pending'
  | 'not-present'

export interface OrthographyExceptionOpOutcome {
  word: string
  action: OrthographyExceptionAction
  effect: OrthographyExceptionEffect
  /** Plain-language line for the approval page. */
  line: string
}

export interface OrthographyExceptionMerge {
  /** The list as it would be stored, in list order (new entries appended). */
  exceptions: OrthographyException[]
  outcomes: OrthographyExceptionOpOutcome[]
  added: number
  approved: number
  removed: number
  /** Ops that found the list already in the state they asked for. */
  unchanged: number
  /** True when the list would be written — false makes the commit a no-op. */
  changed: boolean
}

export interface OrthographyExceptionActor {
  /** Stamped onto a new entry's `by`. */
  userId: string
  /** MAINTAINER or above: an add lands approved, and may approve a proposal. */
  canApprove: boolean
}

/**
 * Apply `ops` to `live`, the stored exception list. Pure, so the whole rule
 * table is unit-testable without a database — and called by BOTH the prepare
 * preview and the commit write, so the human approving a plan is reading the
 * same function that will run.
 *
 * An op whose state already holds is a NO-OP, never an error: this is a merge,
 * and refusing the whole changeset because one word was approved by a human
 * five minutes ago would defeat the point. Each outcome says which happened.
 */
export function mergeOrthographyExceptions(
  live: readonly OrthographyException[],
  ops: readonly OrthographyExceptionOp[],
  actor: OrthographyExceptionActor,
  apostrophe: string,
): OrthographyExceptionMerge {
  const entries: OrthographyException[] = live.map((entry) => ({ ...entry }))
  const indexOfFold = (fold: string): number =>
    entries.findIndex((entry) => foldExceptionWord(entry.word) === fold)

  const outcomes: OrthographyExceptionOpOutcome[] = []
  let added = 0
  let approved = 0
  let removed = 0
  let unchanged = 0

  for (const op of ops) {
    const word = normalizeExceptionWord(op.word, apostrophe)
    const fold = foldExceptionWord(word)
    const at = indexOfFold(fold)
    const existing = at >= 0 ? entries[at] : null

    if (op.action === 'remove') {
      if (!existing) {
        unchanged += 1
        outcomes.push({ word, action: 'remove', effect: 'not-present', line: `“${word}” is not on the list` })
        continue
      }
      entries.splice(at, 1)
      removed += 1
      outcomes.push({
        word: existing.word,
        action: 'remove',
        effect: 'removed',
        line: `Remove ${existing.status} exception “${existing.word}” — the rules will convert it again`,
      })
      continue
    }

    if (!existing) {
      const status = actor.canApprove ? 'approved' : 'pending'
      entries.push({
        word,
        status,
        by: actor.userId,
        ...(op.ref !== undefined ? { ref: op.ref } : {}),
      })
      added += 1
      outcomes.push({
        word,
        action: 'add',
        effect: 'added',
        line: actor.canApprove
          ? `Add “${word}” as an approved exception — the rules will leave it alone`
          : `Propose “${word}” as an exception (pending — inert until a maintainer approves it)`,
      })
      continue
    }

    if (existing.status === 'approved') {
      unchanged += 1
      outcomes.push({
        word: existing.word,
        action: 'add',
        effect: 'already-approved',
        line: `“${existing.word}” is already an approved exception`,
      })
      continue
    }

    // Pending, and a maintainer is asking for it: that IS the approval. The
    // proposer keeps the credit — `by` and `ref` record who found the word,
    // not who approved it.
    if (actor.canApprove) {
      entries[at] = { ...existing, status: 'approved' }
      approved += 1
      outcomes.push({
        word: existing.word,
        action: 'add',
        effect: 'approved',
        line: `Approve the pending exception “${existing.word}”${existing.by ? ` (proposed by ${existing.by})` : ''}`,
      })
      continue
    }

    unchanged += 1
    outcomes.push({
      word: existing.word,
      action: 'add',
      effect: 'already-pending',
      line: `“${existing.word}” is already proposed and waiting for a maintainer`,
    })
  }

  return {
    exceptions: entries,
    outcomes,
    added,
    approved,
    removed,
    unchanged,
    changed: added + approved + removed > 0,
  }
}

/** True when every op's end-state already holds in `live` — the supersede
 *  predicate's question (external/supersede.ts). A maintainer who added the
 *  words in the app while the plan waited for approval SUPERSEDED it, which is
 *  a healthy outcome, not a stale plan. */
export function orthographyExceptionsSatisfied(
  live: readonly OrthographyException[],
  ops: readonly OrthographyExceptionOp[],
  actor: OrthographyExceptionActor,
  apostrophe: string,
): boolean {
  return !mergeOrthographyExceptions(live, ops, actor, apostrophe).changed
}

