/**
 * Deterministic patch engine (spec §4.4).
 *
 * Patches carry a precondition (`expectedRevision`: the hash of the target
 * content they were computed against) and an authority. The engine:
 *
 *  - is idempotent: an already-processed operationId, or a patch whose result
 *    is already in place, is skipped;
 *  - rejects stale patches whose precondition no longer holds;
 *  - rejects agent patches over human/approved content unless the patch is an
 *    explicit revision after a source change (and even then the engine above
 *    flags it for review);
 *  - canonicalises a batch, so every permutation of the same batch converges
 *    to the same state: patches are applied in causal order (a patch becomes
 *    eligible when its precondition matches), and among concurrent siblings
 *    the winner is chosen by (authority, operationId), never by arrival order.
 */
import { contentHashOf } from "./ledger.ts"
import type { ContentPatch, PatchRejection, PatchResult, TargetUnitState } from "./types.ts"
import { authorityRank } from "./types.ts"

const revisionOf = (s: TargetUnitState | undefined): string => s?.contentHash ?? "none"

const better = (a: ContentPatch, b: ContentPatch): ContentPatch => {
  const ra = authorityRank(a.authority)
  const rb = authorityRank(b.authority)
  if (ra !== rb) return ra > rb ? a : b
  return a.operationId < b.operationId ? a : b
}

export const applyPatches = (
  initial: ReadonlyMap<string, TargetUnitState>,
  patches: readonly ContentPatch[],
  processed: ReadonlySet<string> = new Set(),
): PatchResult => {
  const state = new Map(initial)
  const applied: ContentPatch[] = []
  const skipped: ContentPatch[] = []
  const rejected: PatchRejection[] = []

  // De-duplicate by operationId. Operation ids are content-addressed upstream,
  // so a reused id with a different payload is a protocol error; resolve it
  // deterministically (never by arrival order) and skip the other copy.
  const pending = new Map<string, ContentPatch>()
  for (const p of patches) {
    if (processed.has(p.operationId)) {
      skipped.push(p)
      continue
    }
    const seen = pending.get(p.operationId)
    if (!seen) pending.set(p.operationId, p)
    else {
      const keep = canonicalOf(seen) <= canonicalOf(p) ? seen : p
      skipped.push(keep === seen ? p : seen)
      pending.set(p.operationId, keep)
    }
  }

  const byUnit = new Map<string, ContentPatch[]>()
  for (const p of pending.values()) {
    const list = byUnit.get(p.logicalId) ?? []
    list.push(p)
    byUnit.set(p.logicalId, list)
  }

  for (const unitId of [...byUnit.keys()].sort()) {
    let open = byUnit.get(unitId)!
    for (;;) {
      const current = state.get(unitId)
      const rev = revisionOf(current)
      const candidates = open.filter((p) => p.expectedRevision === rev)
      if (candidates.length === 0) break
      const eligible: ContentPatch[] = []
      for (const p of candidates) {
        const verdict = check(p, current)
        if (verdict) {
          rejected.push(verdict)
          open = open.filter((q) => q !== p)
        } else eligible.push(p)
      }
      if (eligible.length === 0) continue
      const winner = eligible.reduce(better)
      open = open.filter((p) => p !== winner)
      // Concurrent siblings that lost to the winner.
      for (const loser of eligible.filter((p) => p !== winner)) {
        const sameResult = loser.operation === winner.operation && loser.content === winner.content
        if (sameResult) skipped.push(loser)
        else rejected.push({ patch: loser, reason: "stale", detail: `concurrent with ${winner.operationId}, which won by authority/order` })
        open = open.filter((p) => p !== loser)
      }
      if (winner.operation === "delete") {
        state.delete(unitId)
        applied.push(winner)
        continue
      }
      const content = winner.content!
      const next: TargetUnitState = { content, contentHash: contentHashOf(content), authority: winner.authority }
      // Same content: nothing to write. Never downgrade authority by re-stating the same words.
      if (current && current.contentHash === next.contentHash && authorityRank(next.authority) <= authorityRank(current.authority)) {
        skipped.push(winner)
        continue
      }
      state.set(unitId, next)
      applied.push(winner)
    }
    for (const p of open) {
      const current = state.get(unitId)
      const reachable =
        p.operation !== "delete" && p.content !== undefined && current && current.contentHash === contentHashOf(p.content)
      if (reachable) skipped.push(p)
      else rejected.push({ patch: p, reason: "stale", detail: `expected ${p.expectedRevision}, found ${revisionOf(current)}` })
    }
  }
  const decided = new Set([...processed, ...applied.map((p) => p.operationId), ...skipped.map((p) => p.operationId), ...rejected.map((r) => r.patch.operationId)])
  return { state, applied, skipped, rejected, processed: decided }
}

const canonicalOf = (p: ContentPatch): string => JSON.stringify([p.logicalId, p.expectedRevision, p.operation, p.content ?? null, p.authority, p.revisesHuman ?? false])

const check = (p: ContentPatch, current: TargetUnitState | undefined): PatchRejection | undefined => {
  if (p.operation !== "delete" && p.content === undefined) {
    return { patch: p, reason: "missing-content", detail: `${p.operation} without content` }
  }
  if (current && current.authority !== "agent" && p.authority === "agent" && !p.revisesHuman) {
    return { patch: p, reason: "unauthorized", detail: `agent patch may not overwrite ${current.authority} content` }
  }
  return undefined
}
