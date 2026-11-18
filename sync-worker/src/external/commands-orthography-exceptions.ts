// PatchOrthographyExceptions — add or remove words the lane's orthography
// rules must leave alone (AQU-2642 §4, following AQU-2628).
//
// WHY THIS IS NOT `PatchSettings { key: 'languageProfile' }`.
// PatchSettings replaces a key WHOLESALE, so proposing one exception means
// reading the whole profile, appending to its `exceptions` array and writing
// the lot back. Two people (or an agent and a maintainer in the app) doing
// that around the same time is last-write-wins on a list that carries
// AUTHORSHIP: the loser's entry disappears, and nothing says it did. On a
// list where every entry records who asked for it and whether a maintainer
// approved it, silently dropping one is not an acceptable outcome of a race.
//
// So this command carries OPS, not a list, and the list is computed at COMMIT
// from the then-current stored value:
//
//   * an entry someone else added between prepare and commit survives;
//   * `ifMatchVersion` is therefore OPTIONAL — a version bump under a merge is
//     not a conflict, it is the case the merge exists for. Pass it to assert
//     nothing changed since you read the profile (`plan_stale` on drift);
//   * the write itself still goes through the version-guarded settings write
//     (`patchProjectSettingsShared`), pinned to the version read in the same
//     pass, so the rest of the settings blob can never be clobbered. A lost
//     race re-reads and re-merges rather than overwriting.
//
// ROLES (AQU-2642 §4): CONTRIBUTOR may PROPOSE — an add lands `pending` and is
// inert until approved (db/shared/orthography.ts rule 2, so a proposal changes
// no text). MAINTAINER's add lands `approved`, and a maintainer's add over
// someone's pending entry IS the approval: the status changes and the original
// proposer keeps the credit. Removal is MAINTAINER-only — dropping an approved
// exception re-exposes a word to the rules, which rewrites text.
//
// Not a cheaper door onto the settings blob: the only key it can touch is
// `languageProfile.orthography.exceptions`, and a project with no orthography
// block is refused rather than seeded with one (that is a MAINTAINER
// PatchSettings write, where the rules and the apostrophe are decided).
//
// The merge itself is PURE and lives in db/shared/orthography-exceptions.ts, so
// the prepare preview, the commit write, the supersede predicate and (when it
// lands) the in-app "Add as exception" affordance all run one rule table. This
// module owns only the API shape, the live role resolution and the write.
//
// Spec: aquilla-specs 04-features/checks-rules-and-living-memory.md and
// 05-user-stories/review-suggested-fix.md.

import { errorResponse, toErrorResponse } from './errors'
import { markChangesetStale, receiptOnlyGates, writeCommittedReceipt } from './commit-gates'
import { stageAndRespond } from './stage'
import { assertCredentialScope } from './token-bridge'
import type {
  ChangesetSummary,
  ExternalEnv,
  ProvenanceChannel,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { loadProjectSettings, patchProjectSettingsShared } from '../../../db/shared/projects'
import { readLanguageProfile } from '../../../db/shared/language-profile'
import {
  MAX_ORTHOGRAPHY_EXCEPTIONS,
  exceptionWordProblem,
  foldExceptionWord,
  type OrthographyException,
} from '../../../db/shared/orthography'
import {
  MAX_ORTHOGRAPHY_EXCEPTION_OPS,
  ORTHOGRAPHY_EXCEPTION_ACTIONS,
  mergeOrthographyExceptions,
  type OrthographyExceptionAction,
  type OrthographyExceptionActor,
  type OrthographyExceptionMerge,
  type OrthographyExceptionOp,
} from '../../../db/shared/orthography-exceptions'
import { ROLE, roleLabel } from '../events/role-policy'

export {
  MAX_ORTHOGRAPHY_EXCEPTION_OPS,
  mergeOrthographyExceptions,
  orthographyExceptionsSatisfied,
} from '../../../db/shared/orthography-exceptions'
export type {
  OrthographyExceptionAction,
  OrthographyExceptionOp,
} from '../../../db/shared/orthography-exceptions'

export interface PatchOrthographyExceptionsCommand {
  kind: 'PatchOrthographyExceptions'
  projectId: string
  ops: OrthographyExceptionOp[]
  /** Optional settings-version pin. See the header: a merge tolerates drift,
   *  so this asserts "nothing changed since I read the profile" when the
   *  caller wants that, and is otherwise left out. */
  ifMatchVersion?: number
}

/** Longest a `ref` may be — the same cap a stored entry's `ref` passes. */
const MAX_REF_LENGTH = 200

/** Static index floor: the lowest role that can use the command at all. An
 *  `add` is a proposal from CONTRIBUTOR up; `remove` re-checks MAINTAINER
 *  live at prepare and at commit. */
export const PATCH_ORTHOGRAPHY_EXCEPTIONS_REQUIRED_ROLE = ROLE.CONTRIBUTOR

/** Role that may APPROVE an exception (and remove one). */
export const ORTHOGRAPHY_APPROVAL_ROLE = ROLE.MAINTAINER

export const NO_ORTHOGRAPHY_MESSAGE =
  'this project has no languageProfile.orthography block, so it has no exception list — ' +
  'a maintainer sets the rules and the apostrophe first with PatchSettings { key: "languageProfile" }'

export interface OrthographyExceptionValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * Validate one raw PatchOrthographyExceptions command — shape only. The role
 * floors, the live profile and the merge are prepare/commit checks.
 *
 * Every bad op is reported, not only the first (AQU-2402's lesson on
 * PatchSettings): a bulk paste with three malformed words should cost one
 * round trip, not three.
 */
export function validatePatchOrthographyExceptionsCommand(
  c: Record<string, unknown>,
  index: number,
  issues: OrthographyExceptionValidationIssue[],
): PatchOrthographyExceptionsCommand | null {
  const kind = 'PatchOrthographyExceptions'
  if (!isNonEmptyString(c.projectId)) {
    issues.push({ index, message: `${kind}.projectId must be a non-empty string` })
    return null
  }
  if (c.ifMatchVersion !== undefined) {
    if (
      typeof c.ifMatchVersion !== 'number' ||
      !Number.isInteger(c.ifMatchVersion) ||
      c.ifMatchVersion < 0
    ) {
      issues.push({ index, message: `${kind}.ifMatchVersion must be an integer >= 0 when given` })
      return null
    }
  }
  if (!Array.isArray(c.ops) || c.ops.length === 0) {
    issues.push({ index, message: `${kind}.ops must be a non-empty array` })
    return null
  }
  if (c.ops.length > MAX_ORTHOGRAPHY_EXCEPTION_OPS) {
    issues.push({
      index,
      message: `${kind}.ops must list at most ${MAX_ORTHOGRAPHY_EXCEPTION_OPS} words per changeset (got ${c.ops.length})`,
    })
    return null
  }

  const ops: OrthographyExceptionOp[] = []
  // Two ops on the same word in one changeset would make the outcome depend on
  // their order — a caller bug, like PatchSettings' duplicate key. Compared on
  // the FOLD, because that is what makes two spellings the same exception.
  const seen = new Set<string>()
  let bad = false
  for (const [opIndex, rawOp] of c.ops.entries()) {
    const where = `${kind}.ops[${opIndex}]`
    if (typeof rawOp !== 'object' || rawOp === null || Array.isArray(rawOp)) {
      issues.push({ index, message: `${where} must be an object` })
      bad = true
      continue
    }
    const op = rawOp as Record<string, unknown>
    for (const key of Object.keys(op)) {
      if (key !== 'action' && key !== 'word' && key !== 'ref') {
        issues.push({ index, message: `${where} has an unknown field "${key}"` })
        bad = true
      }
    }
    if (!(ORTHOGRAPHY_EXCEPTION_ACTIONS as readonly unknown[]).includes(op.action)) {
      issues.push({
        index,
        message: `${where}.action must be one of ${ORTHOGRAPHY_EXCEPTION_ACTIONS.join(', ')}`,
      })
      bad = true
      continue
    }
    const wordProblem = exceptionWordProblem(op.word)
    if (wordProblem) {
      issues.push({ index, message: `${where}.${wordProblem}` })
      bad = true
      continue
    }
    const word = op.word as string
    if (op.ref !== undefined && (typeof op.ref !== 'string' || op.ref.length > MAX_REF_LENGTH)) {
      issues.push({ index, message: `${where}.ref must be a string of at most ${MAX_REF_LENGTH} characters` })
      bad = true
      continue
    }
    const fold = foldExceptionWord(word)
    if (fold.length === 0) {
      issues.push({ index, message: `${where}.word must contain at least one letter or digit` })
      bad = true
      continue
    }
    if (seen.has(fold)) {
      issues.push({ index, message: `${where}.word "${word}" is named more than once in this changeset` })
      bad = true
      continue
    }
    seen.add(fold)
    ops.push({
      action: op.action as OrthographyExceptionAction,
      word,
      ...(op.ref !== undefined ? { ref: op.ref as string } : {}),
    })
  }
  if (bad) return null

  return {
    kind,
    projectId: c.projectId,
    ops,
    ...(c.ifMatchVersion !== undefined ? { ifMatchVersion: c.ifMatchVersion as number } : {}),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The STORED `languageProfile` object, not the reader's view of it.
 * `readLanguageProfile` drops a slot this version does not know, so writing
 * its output back would delete one; a writer merges over the stored object
 * (db/shared/language-profile.ts header).
 */
function storedLanguageProfile(settings: Record<string, unknown>): Record<string, unknown> {
  const raw = settings.languageProfile
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  return isPlainObject(value) ? value : {}
}

/** The op that writes the merged list, preserving every other slot and every
 *  field of the orthography block this version does not know about. */
function languageProfileOp(
  settings: Record<string, unknown>,
  exceptions: readonly OrthographyException[],
): { key: string; value: unknown } {
  const profile = storedLanguageProfile(settings)
  const orthography = isPlainObject(profile.orthography) ? profile.orthography : {}
  return {
    key: 'languageProfile',
    value: { ...profile, orthography: { ...orthography, exceptions: [...exceptions] } },
  }
}

interface ResolvedActor {
  actor: OrthographyExceptionActor
  role: number
}

/** The live role check both paths run: the CONTRIBUTOR floor, and MAINTAINER
 *  when the plan removes anything. */
async function resolveActor(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  ops: readonly OrthographyExceptionOp[],
): Promise<ResolvedActor | Response> {
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  const level = role?.level ?? 0
  if (level < PATCH_ORTHOGRAPHY_EXCEPTIONS_REQUIRED_ROLE) {
    return errorResponse(
      'permission_denied',
      `insufficient project role to propose orthography exceptions (${roleLabel(
        PATCH_ORTHOGRAPHY_EXCEPTIONS_REQUIRED_ROLE,
      )} required)`,
      { requiredRole: PATCH_ORTHOGRAPHY_EXCEPTIONS_REQUIRED_ROLE },
    )
  }
  const canApprove = level >= ORTHOGRAPHY_APPROVAL_ROLE
  if (!canApprove && ops.some((op) => op.action === 'remove')) {
    return errorResponse(
      'permission_denied',
      `removing an orthography exception re-exposes the word to the rules, so it is ${roleLabel(
        ORTHOGRAPHY_APPROVAL_ROLE,
      )}-only — an add from this role is staged as a pending proposal instead`,
      { requiredRole: ORTHOGRAPHY_APPROVAL_ROLE },
    )
  }
  return { actor: { userId: String(cred.userId), canApprove }, role: level }
}

function capDenial(count: number): Response | null {
  if (count <= MAX_ORTHOGRAPHY_EXCEPTIONS) return null
  return errorResponse(
    'validation_failed',
    `the merged exception list would hold ${count} words, over the ${MAX_ORTHOGRAPHY_EXCEPTIONS} a profile may carry`,
    { max: MAX_ORTHOGRAPHY_EXCEPTIONS, would: count },
  )
}

/**
 * Prepare a PatchOrthographyExceptions changeset (sole command). Resolves the
 * live role, refuses a project with no orthography block, and previews the
 * merge against the CURRENT list so the approval page names each word and what
 * happens to it. The commit re-merges against the list as it stands then — so
 * the preview is the plan's intent, and the receipt is what landed.
 */
export async function preparePatchOrthographyExceptions(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: PatchOrthographyExceptionsCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return errorResponse(
      'validation_failed',
      'PatchOrthographyExceptions.projectId must match the changeset project',
    )
  }

  const resolved = await resolveActor(db, cred, urlProjectId, cmd.ops)
  if (resolved instanceof Response) return resolved

  const current = await loadProjectSettings(db, urlProjectId)
  if (cmd.ifMatchVersion !== undefined && current.version !== cmd.ifMatchVersion) {
    return errorResponse('plan_stale', 'settings version changed since it was read', {
      expected: cmd.ifMatchVersion,
      current: current.version,
    })
  }

  const orthography = readLanguageProfile(current.settings.languageProfile).orthography
  if (!orthography) return errorResponse('validation_failed', NO_ORTHOGRAPHY_MESSAGE)

  const merge = mergeOrthographyExceptions(
    orthography.exceptions ?? [],
    cmd.ops,
    resolved.actor,
    orthography.apostrophe,
  )
  const cap = capDenial(merge.exceptions.length)
  if (cap) return cap

  // Keyed per word, like SetBrief keys `settingsChanges` per brief section, so
  // the approval page renders one line per word with no new summary field.
  const settingsChanges: Record<string, string> = {}
  for (const outcome of merge.outcomes) {
    settingsChanges[`languageProfile.orthography.exceptions[${outcome.word}]`] = outcome.line
  }
  const summary: ChangesetSummary = {
    command: 'PatchOrthographyExceptions',
    projectId: urlProjectId,
    ...(cmd.ifMatchVersion !== undefined ? { ifMatchVersion: cmd.ifMatchVersion } : {}),
    settingsChanges,
    warnings: merge.changed
      ? []
      : [
          {
            code: 'inert_write' as const,
            fileId: '',
            cellId: '',
            message:
              'every word in this plan is already in the state it asks for, so committing it ' +
              'changes nothing — a maintainer may have decided these already',
          },
        ],
  }

  return stageAndRespond(db, env, {
    id,
    projectId: urlProjectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [cmd],
    preconditions: [],
    summary,
    // No planned ids: the merge computes the list at COMMIT from the live
    // value, so there is nothing about the outcome to pin at prepare. The
    // optional `ifMatchVersion` lives on the command itself.
    plannedIds: {},
  })
}

/** How many times the commit re-reads and re-merges under a concurrent
 *  settings write before giving up. Three is a long way past any real race on
 *  one project's settings row; past it, something is writing in a loop. */
const MERGE_ATTEMPTS = 3

/**
 * Commit a PatchOrthographyExceptions changeset (receipt-only). Re-asserts the
 * credential scope and the live role, consumes the ask-mode approval once,
 * then merges the ops into the THEN-CURRENT list and writes it through the
 * version-guarded settings write. A conflict re-reads and re-merges rather
 * than failing: the merge is the whole reason this command exists.
 */
export async function commitPatchOrthographyExceptions(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: PatchOrthographyExceptionsCommand,
  channel: ProvenanceChannel,
): Promise<Response> {
  const projectId = cs.projectId

  // Receipt-only paths mint no internal token, so the credential's scope
  // ceiling is re-asserted here (H1 parity with PatchSettings).
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const resolved = await resolveActor(db, cred, projectId, cmd.ops)
  if (resolved instanceof Response) return resolved

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const confirmationId = gate.confirmationId

  let lastVersion = 0
  for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt += 1) {
    const live = await loadProjectSettings(db, projectId)
    lastVersion = live.version
    const orthography = readLanguageProfile(live.settings.languageProfile).orthography
    if (!orthography) return errorResponse('validation_failed', NO_ORTHOGRAPHY_MESSAGE)

    const merge = mergeOrthographyExceptions(
      orthography.exceptions ?? [],
      cmd.ops,
      resolved.actor,
      orthography.apostrophe,
    )
    const cap = capDenial(merge.exceptions.length)
    if (cap) return cap

    // Nothing to do — a retried commit, or a human who got there first. Write
    // the receipt rather than bumping the settings version for no change.
    if (!merge.changed) {
      return finishReceipt(db, cred, cs, projectId, live.version, merge, confirmationId, channel)
    }

    const result = await patchProjectSettingsShared(db, {
      projectId,
      ops: [languageProfileOp(live.settings, merge.exceptions)],
      ifMatchVersion: live.version,
      updatedBy: cred.userId,
    })
    if (result.status === 'ok') {
      return finishReceipt(db, cred, cs, projectId, result.settings.version, merge, confirmationId, channel)
    }
    if (result.status === 'error') return errorResponse('job_failed', result.message)
    // conflict: someone wrote the settings between the read and the write.
    // Re-read and re-merge onto what they left behind.
  }

  // The approval was already consumed, so this plan cannot be retried as it
  // stands — mark it stale rather than leaving a staged row nothing will ever
  // apply (the same end PatchSettings gives a lost version race).
  await markChangesetStale(db, cs.id)
  return errorResponse(
    'plan_stale',
    `the project settings were rewritten under this merge ${MERGE_ATTEMPTS} times running — nothing was applied, re-stage the plan`,
    { current: lastVersion, status: 'stale' },
  )
}

async function finishReceipt(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  projectId: string,
  version: number,
  merge: OrthographyExceptionMerge,
  confirmationId: string | null,
  channel: ProvenanceChannel,
): Promise<Response> {
  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: 'PatchOrthographyExceptions',
    appliedAt: new Date().toISOString(),
    projectId,
    version,
    orthographyExceptions: {
      added: merge.added,
      approved: merge.approved,
      removed: merge.removed,
      unchanged: merge.unchanged,
      total: merge.exceptions.length,
      words: merge.outcomes.map(({ word, action, effect }) => ({ word, action, effect })),
    },
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
