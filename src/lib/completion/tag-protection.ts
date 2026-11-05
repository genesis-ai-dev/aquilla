// The SPA's side of the inline-tag protection ladder (AQU-2385).
//
// The rules live in `db/shared/inline-tags.ts` so the server-side agent draft
// tool runs exactly the same ones. This module is the drafting paths' seam:
// what the prompt carries, how a reply is settled, and the per-browser switch
// that turns MASKING off while leaving detection and repair on.
//
// Where it sits, deliberately:
//   - Around the model call ONLY. Nothing here reads or writes
//     `originalHtml`, `translatedHtml` or the IDML style catalog.
//   - NOT on the IDML/Biblica protected-markup path. That path already masks,
//     in its own way, with anchors the exporter rebuilds runs from
//     (`normalizeProtectedCompletionWithRepair`). Two protection schemes over
//     one reply would fight, so a protected cell opts out and keeps its
//     existing contract — see `protectPromptSource`'s `active: false`.

import {
  createTagMask,
  extractInlineTags,
  restoreInlineTags,
  maskInlineTags,
  settleTagLadder,
  type TagLadderResult,
  type TagMask,
} from "../../../db/shared/inline-tags"

export { createTagMask, isTagsOnlyText, describeTagFailure } from "../../../db/shared/inline-tags"
export type { TagLadderResult, TagLadderStatus, TagMask } from "../../../db/shared/inline-tags"

/**
 * Per-browser switch for MASKING, the first rung of the ladder. On by default;
 * `"0"` = off, following the same localStorage convention as the health
 * kill-switch (`src/lib/health/kill-switch.ts`).
 *
 * Detection, repair and the quarantine never switch off: this only decides
 * whether the model sees sentinels or the real tags. It exists as an escape
 * hatch for a model or provider that handles the sentinel grammar badly —
 * with it off, a tag the model mangles is still caught and still flagged.
 */
export const INLINE_TAG_MASKING_STORAGE_KEY = "inline-tag-masking"

const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(INLINE_TAG_MASKING_STORAGE_KEY) !== "0"
  } catch {
    return true
  }
}

let enabled = read()

export function isInlineTagMaskingEnabled(): boolean {
  return enabled
}

export function setInlineTagMaskingEnabled(next: boolean): void {
  try {
    localStorage.setItem(INLINE_TAG_MASKING_STORAGE_KEY, next ? "1" : "0")
  } catch {
    // Private-mode / storage-disabled browsers keep the in-memory choice only.
  }
  if (enabled === next) return
  enabled = next
  for (const listener of listeners) listener()
}

export function subscribeInlineTagMasking(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test seam: re-read the stored choice. */
export function __resetInlineTagMaskingForTests(): void {
  enabled = read()
}

// ─── the seam ───────────────────────────────────────────────────────────────

export interface TagProtection {
  /** The real source text, kept for verification. */
  source: string
  /** What the prompt carries — masked when masking is on, else the source. */
  promptSource: string
  /** Present only when this reply was masked. */
  mask?: TagMask
  /**
   * False when there is nothing to protect — the source carries no inline
   * tags, or this is a protected-markup (IDML) cell with its own contract. An
   * inactive protection never masks and never judges the reply, so a plain
   * prose draft is not flagged over markup it was never given.
   */
  active: boolean
}

/**
 * Decide what the prompt carries for one cell.
 *
 * `mask` lets one batch prompt share a single nonce and ordinal sequence
 * across all of its cells, so no two cells can mint the same sentinel.
 */
export function protectPromptSource(
  source: string,
  opts?: { mask?: TagMask; protectedMarkup?: boolean },
): TagProtection {
  const inert = opts?.protectedMarkup === true || extractInlineTags(source).length === 0
  if (inert) return { source, promptSource: source, active: false }
  if (!isInlineTagMaskingEnabled()) return { source, promptSource: source, active: true }
  const { masked, mask } = maskInlineTags(source, opts?.mask ?? createTagMask())
  return { source, promptSource: masked, mask, active: true }
}

/** Restore sentinels in streamed preview text so a translator never sees one. */
export function restoreProtectedPreview(protection: TagProtection, partial: string): string {
  return protection.mask ? restoreInlineTags(partial, protection.mask) : partial
}

/** Run detect → repair → quarantine over one reply. */
export function settleProtectedReply(protection: TagProtection, raw: string): TagLadderResult {
  if (!protection.active) return { status: "clean", value: raw }
  return settleTagLadder(protection.source, raw, protection.mask)
}
