// AQU-1901: what became of ONE event a foreground flow just queued — the
// outcome a "Saved" confirmation has to wait for.
//
// "Accepted" is two different things short of saved: a stale sibling (logged,
// never projected) and a refusal (a non-retryable 4xx inside the 200 — e.g.
// the AQU-1900 422 for a write with no lane — or a 403). The AI-draft flow
// rebased on the first and ignored the second, so a refused draft was dropped
// from the outbox, reported nothing, and the row said "Saved".
//
// A refusal is claimed (see `FlushDeps.onRejected`): the caller reports it, so
// the tab-wide rejection listener does not announce it a second time.

import { flushOutboxUntilSettled, type FlushDeps } from "./outbox-flush"

export type OwnEventOutcome =
  /** Accepted and not dead-lettered — or still queued, if the transport is
   *  down: the background flusher then owns it, as it always did. */
  | { kind: "accepted" }
  /** Accepted but not applied: another write took the slot first. */
  | { kind: "dead-lettered" }
  /** Refused outright; it will never save. */
  | { kind: "refused"; status: number; reason: string }

export async function settleOwnEvent(
  eventId: string,
  deps: Pick<FlushDeps, "getTokenForFile" | "fetchImpl">,
): Promise<OwnEventOutcome> {
  let outcome: OwnEventOutcome = { kind: "accepted" }
  const noteRefusal = (entries: ReadonlyArray<{ id: string; status: number; reason: string }>): string[] => {
    const mine = entries.find((entry) => entry.id === eventId)
    if (!mine) return []
    outcome = {
      kind: "refused",
      status: mine.status,
      reason: mine.reason || `The server refused this change (${mine.status})`,
    }
    return [mine.id]
  }
  await flushOutboxUntilSettled([eventId], {
    ...deps,
    onStaleSiblings: (entries) => {
      if (outcome.kind !== "refused" && entries.some((entry) => entry.id === eventId)) {
        outcome = { kind: "dead-lettered" }
      }
    },
    onRejected: noteRefusal,
    onForbidden: noteRefusal,
  })
  return outcome
}
