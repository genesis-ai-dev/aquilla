import { describe, it, expect } from "vitest"
import { applyOutboxOverlay } from "./audit-stats-overlay"
import type { CellAuditStats } from "@/hooks/useCellsAuditStats"
import type { OutboxRecord } from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"

const SCHEMA = 1

function commit(
  id: string,
  cellId: string,
  author: string,
  clientTs: number,
): CqrsRawEvent<"target.cell.commit"> {
  return {
    id,
    schemaVersion: SCHEMA,
    kind: "target.cell.commit",
    projectId: "p",
    fileId: "f",
    cellId,
    author,
    payload: { value: "v", valueHtml: "<p>v</p>" },
    clientTs,
  }
}

function validate(
  id: string,
  cellId: string,
  author: string,
  editEventId: string,
  clientTs: number,
): CqrsRawEvent<"cell.validate"> {
  return {
    id,
    schemaVersion: SCHEMA,
    kind: "cell.validate",
    projectId: "p",
    fileId: "f",
    cellId,
    author,
    payload: { editEventId },
    clientTs,
  }
}

function unvalidate(
  id: string,
  cellId: string,
  author: string,
  editEventId: string,
  clientTs: number,
): CqrsRawEvent<"cell.unvalidate"> {
  return {
    id,
    schemaVersion: SCHEMA,
    kind: "cell.unvalidate",
    projectId: "p",
    fileId: "f",
    cellId,
    author,
    payload: { editEventId },
    clientTs,
  }
}

function rec(event: CqrsRawEvent, enqueuedAt: number): OutboxRecord {
  return {
    id: event.id,
    enqueuedAt,
    event,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  }
}

const baseStats = (overrides: Partial<CellAuditStats> = {}): CellAuditStats => ({
  cellId: "c1",
  editCount: 1,
  contentHash: "hash",
  lastEditAt: 1000,
  lastEditEventId: "ev-base",
  activeValidators: ["carol"],
  ...overrides,
})

describe("applyOutboxOverlay", () => {
  it("returns the base unchanged when pending is empty", () => {
    const base = new Map([["c1", baseStats()]])
    const out = applyOutboxOverlay({ base, pending: [] })
    expect(out.get("c1")).toEqual(baseStats())
    // Base must not be mutated.
    expect(base.get("c1")?.activeValidators).toEqual(["carol"])
  })

  it("does not mutate the input map's nested arrays", () => {
    const base = new Map([["c1", baseStats()]])
    const out = applyOutboxOverlay({
      base,
      pending: [rec(unvalidate("e1", "c1", "carol", "ev-base", 1100), 1100)],
    })
    expect(out.get("c1")?.activeValidators).toEqual([])
    // Base's validators array stays intact.
    expect(base.get("c1")?.activeValidators).toEqual(["carol"])
  })

  it("cell.commit increments editCount, updates lastEditEventId, and clears validators", () => {
    const base = new Map([["c1", baseStats()]])
    const out = applyOutboxOverlay({
      base,
      pending: [rec(commit("ev-new", "c1", "alice", 1500), 1500)],
    })
    const stats = out.get("c1")!
    expect(stats.editCount).toBe(2)
    expect(stats.lastEditAt).toBe(1500)
    expect(stats.lastEditEventId).toBe("ev-new")
    expect(stats.activeValidators).toEqual([])
  })

  it("cell.validate after a commit binds validator to the new edit", () => {
    const base = new Map([["c1", baseStats()]])
    const out = applyOutboxOverlay({
      base,
      pending: [
        rec(commit("ev-new", "c1", "alice", 1500), 1500),
        rec(validate("ev-v", "c1", "alice", "ev-new", 1510), 1510),
      ],
    })
    expect(out.get("c1")?.activeValidators).toEqual(["alice"])
    expect(out.get("c1")?.lastEditEventId).toBe("ev-new")
  })

  it("cell.validate is idempotent for the same author", () => {
    const base = new Map([
      ["c1", baseStats({ lastEditEventId: "ev-base", activeValidators: [] })],
    ])
    const out = applyOutboxOverlay({
      base,
      pending: [
        rec(validate("v1", "c1", "alice", "ev-base", 1100), 1100),
        rec(validate("v2", "c1", "alice", "ev-base", 1101), 1101),
      ],
    })
    expect(out.get("c1")?.activeValidators).toEqual(["alice"])
  })

  it("a stale validate against a non-current edit does not surface", () => {
    // Server has already moved the cell to ev-new (e.g. another tab committed),
    // but a queued validate from this tab still points at ev-old. Don't show it.
    const base = new Map([
      ["c1", baseStats({ lastEditEventId: "ev-new", activeValidators: [] })],
    ])
    const out = applyOutboxOverlay({
      base,
      pending: [rec(validate("v1", "c1", "alice", "ev-old", 1100), 1100)],
    })
    expect(out.get("c1")?.activeValidators).toEqual([])
  })

  it("cell.unvalidate removes the author from validators", () => {
    const base = new Map([
      [
        "c1",
        baseStats({
          lastEditEventId: "ev-base",
          activeValidators: ["carol", "dan"],
        }),
      ],
    ])
    const out = applyOutboxOverlay({
      base,
      pending: [rec(unvalidate("u1", "c1", "carol", "ev-base", 1100), 1100)],
    })
    expect(out.get("c1")?.activeValidators).toEqual(["dan"])
  })

  it("cell.unvalidate against a non-current edit is a no-op", () => {
    const base = new Map([
      [
        "c1",
        baseStats({
          lastEditEventId: "ev-new",
          activeValidators: ["carol"],
        }),
      ],
    ])
    const out = applyOutboxOverlay({
      base,
      pending: [rec(unvalidate("u1", "c1", "carol", "ev-old", 1100), 1100)],
    })
    expect(out.get("c1")?.activeValidators).toEqual(["carol"])
  })

  it("synthesizes stats for cells absent from the base", () => {
    const base = new Map<string, CellAuditStats>()
    const out = applyOutboxOverlay({
      base,
      pending: [
        rec(commit("ev-1", "c-new", "alice", 1500), 1500),
        rec(validate("v-1", "c-new", "alice", "ev-1", 1510), 1510),
      ],
    })
    const stats = out.get("c-new")!
    expect(stats.editCount).toBe(1)
    expect(stats.lastEditEventId).toBe("ev-1")
    expect(stats.activeValidators).toEqual(["alice"])
  })

  it("commit after validate clears the validator (later edit invalidates prior approval)", () => {
    const base = new Map([
      ["c1", baseStats({ lastEditEventId: "ev-base", activeValidators: [] })],
    ])
    const out = applyOutboxOverlay({
      base,
      pending: [
        rec(validate("v1", "c1", "alice", "ev-base", 1100), 1100),
        rec(commit("ev-new", "c1", "bob", 1200), 1200),
      ],
    })
    expect(out.get("c1")?.activeValidators).toEqual([])
    expect(out.get("c1")?.lastEditEventId).toBe("ev-new")
  })

  it("ignores events without a cellId (project-level events)", () => {
    const base = new Map([["c1", baseStats()]])
    const evNoCell: CqrsRawEvent<"target.cell.commit"> = {
      id: "p1",
      schemaVersion: SCHEMA,
      kind: "target.cell.commit",
      projectId: "p",
      author: "alice",
      payload: { value: "x", valueHtml: "<p>x</p>" },
      clientTs: 1500,
    }
    const out = applyOutboxOverlay({
      base,
      pending: [rec(evNoCell, 1500)],
    })
    expect(out.size).toBe(1)
    expect(out.get("c1")).toEqual(baseStats())
  })
})
