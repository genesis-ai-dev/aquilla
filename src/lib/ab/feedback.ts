// Model A/B outcome reporting — the client half of the platform experiment
// (auth-worker lib/model-ab.ts). When a completion response carries an X-AB-*
// assignment, useCompletion notes it here against the cell it drafted; the
// editor then reports the user's first gesture on that draft:
//
//   accepted — the user validated the cell (the "this is good" signal)
//   edited   — a human commit overwrote the AI draft
//
// The map is session-scoped and in-memory on purpose. A draft validated in a
// later session simply reports nothing ("pending" in the admin results) —
// both arms lose cross-session feedback at the same rate, so the comparison
// stays unbiased. Reports are fire-and-forget: telemetry must never block or
// break the editing flow. First gesture wins (the server also enforces
// first-write-wins).

import { FRONTIER_CHAT_URL, type AbAssignment } from "@/lib/completion/completion-service"
import { loadSession } from "@/lib/frontier/session-store"

export type AbOutcome = "accepted" | "edited" | "rejected"

const AB_FEEDBACK_URL = FRONTIER_CHAT_URL.replace(/\/completions$/, "/ab-feedback")

/** `${fileId}:${cellId}` → the assignment that drafted that cell's content. */
const pending = new Map<string, AbAssignment>()

const cellKey = (fileId: string, cellId: string): string => `${fileId}:${cellId}`

/** Note that `cellId`'s current AI draft came from an A/B-assigned request. */
export function noteAbAssignment(fileId: string, cellId: string, ab: AbAssignment): void {
  pending.set(cellKey(fileId, cellId), ab)
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
 * -assigned; no-op otherwise. Consumes the entry (first gesture wins — the
 * server also enforces this) and POSTs fire-and-forget with the active
 * session's jwt.
 */
export function reportAbOutcome(fileId: string, cellId: string, outcome: AbOutcome): void {
  const key = cellKey(fileId, cellId)
  const ab = pending.get(key)
  if (!ab) return
  pending.delete(key)
  void (async () => {
    const session = await loadSession()
    if (!session?.jwt) return
    await fetch(AB_FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.jwt}` },
      body: JSON.stringify({ requestId: ab.requestId, outcome }),
    })
  })().catch(() => {
    // Telemetry only — never surface a failure to the user.
  })
}
