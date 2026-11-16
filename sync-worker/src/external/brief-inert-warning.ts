// AQU-2425 — a brief write that reaches no prompt must not pass approval
// silently.
//
// Since AQU-2342 one saved text decides every AI prompt: the project's
// `translationInstructions`. `resolveTranslationInstructions` returns that
// stored text FIRST, and a stored string is authoritative even when blank (a
// maintainer who cleared the field meant "no instructions"). So once the key
// is stored, the translation brief composes into no prompt at all — a brief
// change still edits the document, and changes nothing the AI reads.
//
// The product call here is WARN AND KEEP THE WRITE, not redirect and not
// refuse:
//   - the brief is still a real document people read, export and maintain, and
//     AQU-2407 acceptance 2 keeps raw `translationBrief` writes on purpose, so
//     refusing would break agents that legitimately maintain it;
//   - redirecting into `translationInstructions` would replace words a person
//     wrote without their approving THAT change, which this issue's own "must
//     not change" line forbids;
//   - AQU-2404 is the precedent: a stranded custom `systemPrompt` warns.
//
// Every door that can write the brief attaches this warning at prepare, so the
// approver is told before they approve (the approval page already renders
// `summary.warnings`, so this needs no UI change). This module is the single
// place that rule changes if the owner of AQU-2342 later wants redirect or
// refuse instead.

import type { ChangesetWarning } from './types'
import {
  TRANSLATION_INSTRUCTIONS_KEY,
  storedTranslationInstructions,
} from '../../../db/shared/translation-instructions'

/** Warning code for a write that lands but reaches no prompt. */
export const BRIEF_INERT_WARNING_CODE = 'inert_write'

/**
 * Settings a plan LEAVES BEHIND for the instructions key.
 *
 * `undefined` — this plan does not touch the key, so the live blob decides.
 * `string`    — this plan stores that text, so the brief it writes in the same
 *               breath is stranded by its own sibling.
 * `null`      — this plan leaves the key unstored, so the brief is live again.
 */
export type PlannedInstructions = string | null | undefined

/** Read the instructions a settings-shaped object leaves stored. */
export function plannedInstructionsOf(
  settings: Record<string, unknown> | null | undefined,
): string | null {
  return storedTranslationInstructions(settings)
}

/** Read what a single key/value op leaves stored, or `undefined` when the op
 *  list never names the instructions key. */
export function plannedInstructionsOfOps(
  ops: readonly { key: string; value: unknown }[] | null | undefined,
): PlannedInstructions {
  // Last write wins, matching the per-key merge the commit applies.
  let planned: PlannedInstructions = undefined
  for (const op of ops ?? []) {
    if (op.key !== TRANSLATION_INSTRUCTIONS_KEY) continue
    planned = storedTranslationInstructions({ [TRANSLATION_INSTRUCTIONS_KEY]: op.value })
  }
  return planned
}

/**
 * Does a brief write staged against `current` reach no prompt?
 *
 * The question is asked of the state the changeset LEAVES BEHIND, not of the
 * state it found: a plan that writes the Instructions text in the same breath
 * strands its own brief, and a whole-blob replace that drops the key hands the
 * job back to the brief.
 */
export function briefWriteIsInert(
  current: Record<string, unknown> | null | undefined,
  plannedInstructions: PlannedInstructions = undefined,
): boolean {
  const left =
    plannedInstructions === undefined ? storedTranslationInstructions(current) : plannedInstructions
  return left !== null
}

/** The warning itself. Settings-level, so it carries no file or cell — the
 *  same shape `superseded_step` uses. */
export function briefInertWarning(plannedInstructions: PlannedInstructions = undefined): ChangesetWarning {
  const because =
    typeof plannedInstructions === 'string'
      ? `this same change saves the project's Instructions text, which strands the brief it writes`
      : `this project has saved Instructions`
  return {
    code: BRIEF_INERT_WARNING_CODE,
    fileId: '',
    cellId: '',
    message:
      `this brief change will not reach the AI: ${because}, and the saved Instructions are ` +
      `what every drafting prompt reads. The brief document still changes. To change what the ` +
      `AI reads, write the \`${TRANSLATION_INSTRUCTIONS_KEY}\` setting instead.`,
  }
}

/** `[warning]` when a brief write staged against `current` is inert, else `[]`
 *  — spread straight into a `ChangesetSummary.warnings`. */
export function briefInertWarnings(
  current: Record<string, unknown> | null | undefined,
  plannedInstructions: PlannedInstructions = undefined,
): ChangesetWarning[] {
  return briefWriteIsInert(current, plannedInstructions)
    ? [briefInertWarning(plannedInstructions)]
    : []
}
