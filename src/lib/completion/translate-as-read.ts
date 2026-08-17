import { effectiveSourceText } from "@/lib/cell-text"
import { tokenizeText } from "@/lib/search/tokenizer"
import type { AiDraftProvenance } from "@/lib/sync/outbox-types"
import type { CellData } from "@/hooks/useCells"
import type { ValidatedPair } from "./completion-service"

export interface TranslationEvidenceSnapshot {
  /** Fraction of distinct source tokens attested by the selected examples. */
  coverage: number
  /** Confidence rises with several independent examples and saturates at five. */
  weight: number
  approvedExampleCount: number
  exampleIds: string[]
}

export type TranslateAsReadAction = "draft" | "refresh"

const TRANSLATE_AS_READ_CLAIM_TTL_MS = 5 * 60 * 1000

interface TranslateAsReadLockManager {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>
}

interface TranslateAsReadClaimEnvironment {
  locks: TranslateAsReadLockManager | null
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null
  now: () => number
}

export interface TranslateAsReadClaimOutcome {
  /** Keep this state fingerprint claimed: it either committed or was
   * conclusively found ineligible. False allows a later retry. */
  remember: boolean
  committed: boolean
}

export interface TranslateAsReadClaimResult {
  /** False means another tab owns or already completed this exact attempt. */
  ran: boolean
  outcome?: TranslateAsReadClaimOutcome
}

function claimFingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function defaultClaimEnvironment(): TranslateAsReadClaimEnvironment {
  return {
    locks: typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks as unknown as TranslateAsReadLockManager
      : null,
    storage: typeof localStorage !== "undefined" ? localStorage : null,
    now: Date.now,
  }
}

/**
 * Coordinates viewport drafting across same-origin tabs. Web Locks prevents
 * simultaneous requests; the short-lived local marker closes the gap where a
 * second tab acquires the lock just after the first request finishes but before
 * the winning cell event has reached that tab's local projection.
 */
export async function withTranslateAsReadClaim(
  scopeKey: string,
  attemptKey: string,
  task: () => Promise<TranslateAsReadClaimOutcome>,
  environment: TranslateAsReadClaimEnvironment = defaultClaimEnvironment(),
): Promise<TranslateAsReadClaimResult> {
  if (!environment.locks || !environment.storage) {
    return { ran: true, outcome: await task() }
  }

  const scopeFingerprint = claimFingerprint(scopeKey)
  const attemptFingerprint = claimFingerprint(attemptKey)
  const lockName = `aquilla-translate-as-read:${scopeFingerprint}`
  const storageKey = `aquilla:translate-as-read:${scopeFingerprint}`

  return environment.locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) return { ran: false }

    const now = environment.now()
    try {
      const existing = JSON.parse(environment.storage?.getItem(storageKey) ?? "null") as {
        attempt?: string
        claimedAt?: number
      } | null
      if (
        existing?.attempt === attemptFingerprint
        && typeof existing.claimedAt === "number"
        && now - existing.claimedAt < TRANSLATE_AS_READ_CLAIM_TTL_MS
      ) {
        return { ran: false }
      }
    } catch {
      // A malformed/stale marker is safe to replace while this tab owns the lock.
    }

    environment.storage?.setItem(storageKey, JSON.stringify({
      attempt: attemptFingerprint,
      claimedAt: now,
    }))

    try {
      const outcome = await task()
      if (outcome.remember) {
        environment.storage?.setItem(storageKey, JSON.stringify({
          attempt: attemptFingerprint,
          claimedAt: environment.now(),
        }))
      } else if (environment.storage?.getItem(storageKey)?.includes(attemptFingerprint)) {
        environment.storage.removeItem(storageKey)
      }
      return { ran: true, outcome }
    } catch (error) {
      if (environment.storage?.getItem(storageKey)?.includes(attemptFingerprint)) {
        environment.storage.removeItem(storageKey)
      }
      throw error
    }
  })
}

/**
 * Decide whether viewport automation is allowed to touch a cell at all.
 * `aiDrafted` is the durable ownership boundary: the server clears it on the
 * first human edit or validation, so human-owned text can never enter the
 * automatic refresh path.
 */
export function translateAsReadAction(cell: CellData): TranslateAsReadAction | null {
  if (!effectiveSourceText(cell).trim()) return null
  if (cell.status === "validated" || cell.activeValidators.length > 0) return null
  // Empty means untranslated for this mode, regardless of whether an older
  // empty target head exists. Human ownership only protects existing text.
  if (!cell.translated.trim()) return "draft"
  return cell.aiDrafted ? "refresh" : null
}

/**
 * Measure the evidence actually placed in the translation prompt. Coverage is
 * computed over the union of example-source tokens, so a newly validated
 * example only counts as better evidence when it covers more of this source or
 * adds an independent example without reducing coverage.
 */
export function measureTranslationEvidence(
  sourceText: string,
  examples: ValidatedPair[],
): TranslationEvidenceSnapshot {
  const sourceTokens = new Set(tokenizeText(sourceText))
  const attested = new Set<string>()
  for (const example of examples) {
    for (const token of tokenizeText(example.source)) {
      if (sourceTokens.has(token)) attested.add(token)
    }
  }

  const exampleIds = Array.from(new Set(
    examples.map((example) => example.cellId).filter((id): id is string => Boolean(id)),
  ))
  return {
    coverage: sourceTokens.size > 0 ? attested.size / sourceTokens.size : 0,
    weight: Math.min(1, examples.length / 5),
    approvedExampleCount: examples.length,
    exampleIds,
  }
}

/**
 * A small margin prevents retrieval-order jitter from repeatedly rewriting a
 * draft. One clearly better coverage step, or one additional independent
 * example without a coverage regression, is considered material.
 */
export function hasMateriallyBetterEvidence(
  previous: AiDraftProvenance | undefined,
  current: TranslationEvidenceSnapshot,
): boolean {
  // Pre-provenance AI heads can be identified from their winning event, but
  // cannot tell us which examples the older prompt saw. Give each such legacy
  // draft one conservative upgrade when the current prompt has validated
  // evidence; the replacement then carries a complete snapshot and returns to
  // the strict comparisons below.
  if (!previous) return current.approvedExampleCount > 0
  const oldCoverage = previous.projectState.evidenceCoverage
  const oldWeight = previous.projectState.evidenceWeight

  // Older provenance did not record coverage. We can still prove improvement
  // when the prompt now contains more approved evidence, but never infer it
  // merely because the retrieved identities changed.
  if (oldCoverage === undefined || oldWeight === undefined) {
    return current.approvedExampleCount > previous.projectState.approvedExampleCount
  }

  const coverageGain = current.coverage - oldCoverage
  const weightGain = current.weight - oldWeight
  return coverageGain >= 0.05
    || (coverageGain >= -0.005 && weightGain >= 0.19)
}

/** Stable identity for one candidate state; used to avoid retry loops. */
export function translateAsReadAttemptKey(cell: CellData): string {
  return [
    cell.sourceEventId ?? "",
    cell.targetEventId ?? "",
    cell.aiDraft?.generatedAt ?? "",
    cell.translated,
  ].join("\u0000")
}
