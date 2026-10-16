// Smart edits — which (before, after) pairs in a cell's commit history count as
// one human edit.
//
// The editor commits on idle, so one sitting of typing is several commits. The
// old ICE memory counted every save and so counted half-typed words. Here a
// HUMAN commit is "settled" only when nothing follows it on the same cell
// within SETTLE_WINDOW_MS; a machine commit (AI draft, agent, propagation) is
// always settled because it is a finished snapshot by construction. A pair is
// (nearest settled ancestor → settled human commit). The before side may be a
// machine draft — "what people change in AI drafts" is the richest signal we
// have — but the after side is always a person.

export const SETTLE_WINDOW_MS = 10 * 60 * 1000

export type CommitOrigin = "human" | "ai" | "machine"

export interface ChainEvent {
  id: string
  parentId: string | null
  author: string
  ts: number
  value: string
  /** human = a person typed it; ai = an AI draft; machine = agent, propagation,
   *  harmonize or an accepted smart edit (never evidence of human judgement). */
  origin: CommitOrigin
  /** Replace-all commits share one key per operation, so the memory can count
   *  a bulk replace once rather than once per cell it touched. */
  bulkKey: string | null
}

export interface SettledPair {
  afterId: string
  beforeId: string
  author: string
  ts: number
  before: string
  after: string
  beforeOrigin: CommitOrigin
  bulkKey: string | null
}

/** Classify a target.cell.commit from its payload and provenance. */
export function commitOrigin(payload: Record<string, unknown>, provenanceOrigin: string | null): CommitOrigin {
  if (payload.ai_suggestion === true) return "ai"
  if (provenanceOrigin === "agent") return "machine"
  if (payload.agent_run_id != null) return "machine"
  if (payload.propagated_from_cell_id != null) return "machine"
  if (payload.harmonize_origin != null) return "machine"
  if (payload.smart_edit_id != null) return "machine"
  return "human"
}

export function bulkKeyOf(payload: Record<string, unknown>): string | null {
  const q = payload.search_query
  const r = payload.replace_string
  return typeof q === "string" && typeof r === "string" ? `${q}\u0000${r}` : null
}

/**
 * Settled human pairs in one cell+lane history, restricted to pairs whose
 * after-commit is in (fromTs, now]. `events` may be in any order and may
 * include events older than fromTs — ancestors are needed to find "before".
 */
export function settledPairs(
  events: readonly ChainEvent[],
  now: number,
  fromTs = -Infinity,
  windowMs = SETTLE_WINDOW_MS,
): SettledPair[] {
  const byId = new Map(events.map((e) => [e.id, e]))
  const firstChildTs = new Map<string, number>()
  for (const e of events) {
    if (!e.parentId) continue
    const prev = firstChildTs.get(e.parentId)
    if (prev === undefined || e.ts < prev) firstChildTs.set(e.parentId, e.ts)
  }
  const settled = (e: ChainEvent): boolean => {
    if (e.origin !== "human") return true
    const child = firstChildTs.get(e.id)
    if (child !== undefined) return child - e.ts >= windowMs
    return now - e.ts >= windowMs
  }

  const pairs: SettledPair[] = []
  for (const e of events) {
    if (e.origin !== "human" || e.ts <= fromTs || !settled(e)) continue
    let p = e.parentId ? byId.get(e.parentId) : undefined
    let guard = 0
    while (p && !settled(p) && guard++ < 10_000) p = p.parentId ? byId.get(p.parentId) : undefined
    if (!p || p.value === e.value) continue
    pairs.push({
      afterId: e.id,
      beforeId: p.id,
      author: e.author,
      ts: e.ts,
      before: p.value,
      after: e.value,
      beforeOrigin: p.origin,
      bulkKey: e.bulkKey,
    })
  }
  return pairs
}
