// Model A/B outcome reporting — the client half of the platform experiment
// (auth-worker lib/model-ab.ts). When a completion response carries an X-AB-*
// assignment, useCompletion notes it here against the cell it drafted; the AI
// auto-commit then attaches the draft's actual text (per cell — a batch
// request drafts many cells with different texts). The editor's natural
// gestures report from there:
//
//   accepted — the user validated the cell (the "this is good" signal)
//   edited   — a human commit overwrote the AI draft
//
// Alongside the outcome we send the NORMALIZED EDIT DISTANCE [0,1] between
// the AI draft and the human's text (same character-level Levenshtein as the
// FRO-311 post-edit metrics): 0 = validated verbatim, 1 = fully rewritten.
// The outcome is first-write-wins server-side; the distance refines with each
// further commit (last write wins) so it converges on the final repair cost.
//
// The map is session-scoped and in-memory on purpose. A draft validated in a
// later session simply reports nothing ("pending" in the admin results) —
// both arms lose cross-session feedback at the same rate, so the comparison
// stays unbiased. Reports are fire-and-forget: telemetry must never block or
// break the editing flow.

import { FRONTIER_CHAT_URL, type AbAssignment } from "@/lib/completion/completion-service"
import { loadSession } from "@/lib/frontier/session-store"
import { normalizedEditDistance } from "@/lib/metrics/edit-distance"

export type AbOutcome = "accepted" | "edited" | "rejected"

const AB_FEEDBACK_URL = FRONTIER_CHAT_URL.replace(/\/completions$/, "/ab-feedback")

interface PendingAb {
  ab: AbAssignment
  /** The AI draft's text for THIS cell, captured at the AI auto-commit. */
  draftText?: string
  /** Distance at the most recent human commit — carried into the validate report. */
  lastDistance?: number
}

/** `${fileId}:${cellId}` → the assignment that drafted that cell's content. */
const pending = new Map<string, PendingAb>()

const cellKey = (fileId: string, cellId: string): string => `${fileId}:${cellId}`

/** Note that `cellId`'s next AI draft comes from an A/B-assigned request. */
export function noteAbAssignment(fileId: string, cellId: string, ab: AbAssignment): void {
  pending.set(cellKey(fileId, cellId), { ab })
}

/** Attach the draft text the AI actually committed for this cell. */
export function noteAbDraftText(fileId: string, cellId: string, text: string): void {
  const entry = pending.get(cellKey(fileId, cellId))
  if (entry) entry.draftText = text
}

/** True when the cell has an unreported A/B draft (exposed for tests). */
export function hasPendingAb(fileId: string, cellId: string): boolean {
  return pending.has(cellKey(fileId, cellId))
}

/** Drop all pending assignments (test isolation). */
export function clearPendingAb(): void {
  pending.clear()
}

/**
 * Report the user's gesture on a cell's AI draft, if that draft was A/B
 * -assigned; no-op otherwise.
 *
 * - "edited" (pass the commit's `currentText`): computes the draft→text
 *   distance and KEEPS the entry, so further commits refine the distance.
 * - "accepted" (validate): reports the last known distance (0 when the draft
 *   was never touched) and consumes the entry — validation ends the story.
 *
 * POSTs fire-and-forget with the active session's jwt.
 */
export function reportAbOutcome(
  fileId: string,
  cellId: string,
  outcome: AbOutcome,
  currentText?: string,
): void {
  const key = cellKey(fileId, cellId)
  const entry = pending.get(key)
  if (!entry) return

  let editDistance: number | undefined
  if (outcome === "edited" && entry.draftText !== undefined && currentText !== undefined) {
    editDistance = normalizedEditDistance(entry.draftText, currentText)
    entry.lastDistance = editDistance
  } else if (outcome === "accepted") {
    editDistance = entry.lastDistance ?? 0
  }

  if (outcome !== "edited") {
    // Validation (or rejection) closes this draft's story.
    pending.delete(key)
  }

  void (async () => {
    const session = await loadSession()
    if (!session?.jwt) return
    await fetch(AB_FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.jwt}` },
      body: JSON.stringify({
        requestId: entry.ab.requestId,
        outcome,
        ...(editDistance !== undefined ? { editDistance } : {}),
      }),
    })
  })().catch(() => {
    // Telemetry only — never surface a failure to the user.
  })
}
