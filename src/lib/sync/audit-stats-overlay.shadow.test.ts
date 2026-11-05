import { describe, it, expect } from "vitest"
import {
  applyOutboxOverlay,
  pendingCellIds,
  reconcileFlushShadows,
  type FlushShadowState,
} from "./audit-stats-overlay"
import type { CellAuditStats } from "@/hooks/useCellsAuditStats"
import type { OutboxRecord } from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"

// Why this exists: the overlay lives only as long as the outbox record, but
// the server stats map is refetched AFTER the record is deleted. Without a
// shadow the validation pill flashes validated → unvalidated → validated for
// one GET round trip. These tests pin the bridge and its two release rules.

function validate(id: string, cellId: string, author: string, editEventId: string): CqrsRawEvent<"cell.validate"> {
  return {
    id, schemaVersion: 1, kind: "cell.validate", projectId: "p", fileId: "f", cellId, author,
    payload: { editEventId }, clientTs: 1000,
  }
}

function rec(event: CqrsRawEvent, status: "pending" | "failed" = "pending"): OutboxRecord {
  return { id: event.id, enqueuedAt: 1, attempts: 0, lastAttemptAt: null, lastError: null, status, event } as unknown as OutboxRecord
}

function serverStats(cellId: string, validators: string[]): CellAuditStats {
  return {
    cellId, editCount: 1, contentHash: "h", lastEditAt: 500, lastEditEventId: "e1",
    activeValidators: validators, validatorDecidedTs: {}, waivers: [],
  }
}

/** One render of the hook's useMemo: overlay, then reconcile. */
function render(
  base: Map<string, CellAuditStats>,
  pending: OutboxRecord[],
  st: { shadows: FlushShadowState; prevPendingCellIds: ReadonlySet<string>; prevOverlaid: ReadonlyMap<string, CellAuditStats> | null },
  failedCellIds = new Set<string>(),
) {
  const overlaid = pending.length === 0 ? base : applyOutboxOverlay({ base, pending, lane: "" })
  const r = reconcileFlushShadows({
    base, pending, failedCellIds, overlaid,
    prevPendingCellIds: st.prevPendingCellIds, prevOverlaid: st.prevOverlaid, prev: st.shadows,
  })
  return { out: r.out, st: { shadows: r.shadows, prevPendingCellIds: pendingCellIds(pending), prevOverlaid: r.out } }
}

const fresh = () => ({ shadows: new Map(), prevPendingCellIds: new Set<string>(), prevOverlaid: null })

describe("reconcileFlushShadows", () => {
  it("keeps the validated pill through the flush→refetch gap, then yields to the refetch", () => {
    const base = new Map([["c1", serverStats("c1", [])]])
    // 1. click: record pending → overlay shows the vote
    const r1 = render(base, [rec(validate("v1", "c1", "ann", "e1"))], fresh())
    expect(r1.out.get("c1")?.activeValidators).toEqual(["ann"])
    // 2. flusher deletes the record; server map unchanged → the flash moment
    const r2 = render(base, [], r1.st)
    expect(r2.out.get("c1")?.activeValidators).toEqual(["ann"])
    expect(r2.st.shadows.has("c1")).toBe(true)
    // 2b. unrelated re-renders with the same base keep the shadow
    const r3 = render(base, [], r2.st)
    expect(r3.out.get("c1")?.activeValidators).toEqual(["ann"])
    // 3. targeted refetch replaces the cell's entry → shadow releases, server wins
    const base2 = new Map(base)
    base2.set("c1", serverStats("c1", ["ann"]))
    const r4 = render(base2, [], r3.st)
    expect(r4.st.shadows.size).toBe(0)
    expect(r4.out).toBe(base2)
  })

  it("never shadows a quarantined record: a refused vote must not read as applied", () => {
    const base = new Map([["c1", serverStats("c1", [])]])
    const v = validate("v1", "c1", "ann", "e1")
    const r1 = render(base, [rec(v)], fresh())
    // record flips to failed: it leaves `pending` but is in failedCellIds
    const r2 = render(base, [], r1.st, new Set(["c1"]))
    expect(r2.st.shadows.size).toBe(0)
    expect(r2.out.get("c1")?.activeValidators).toEqual([])
  })

  it("releases a live shadow if its record is later quarantined", () => {
    const base = new Map([["c1", serverStats("c1", [])]])
    const r1 = render(base, [rec(validate("v1", "c1", "ann", "e1"))], fresh())
    const r2 = render(base, [], r1.st)
    expect(r2.st.shadows.has("c1")).toBe(true)
    const r3 = render(base, [], r2.st, new Set(["c1"]))
    expect(r3.st.shadows.size).toBe(0)
  })

  it("lets a new pending record on the same cell draw over the shadow", () => {
    const base = new Map([["c1", serverStats("c1", [])]])
    const r1 = render(base, [rec(validate("v1", "c1", "ann", "e1"))], fresh())
    const r2 = render(base, [], r1.st)
    // user un-validates before the refetch lands: overlay (empty validators) wins
    const un: CqrsRawEvent<"cell.unvalidate"> = { ...validate("u1", "c1", "ann", "e1"), kind: "cell.unvalidate" }
    const r3 = render(base, [rec(un)], r2.st)
    expect(r3.out.get("c1")?.activeValidators).toEqual([])
    // and when THAT flushes, the shadow is re-pinned to the newer value
    const r4 = render(base, [], r3.st)
    expect(r4.out.get("c1")?.activeValidators).toEqual([])
  })

  it("returns the overlay untouched when nothing is shadowed", () => {
    const base = new Map([["c1", serverStats("c1", [])]])
    const r = render(base, [], fresh())
    expect(r.out).toBe(base)
  })
})
