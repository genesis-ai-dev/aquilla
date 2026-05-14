import { describe, it, expect } from "vitest"
import {
  applyDisconnect,
  applyFocusClaim,
  applyFocusRelease,
  applyFocusRenew,
  parseProjectDoClientMessage,
  PROJECT_DO_DEFAULT_LEASE_MS,
  sweepExpiredLeases,
  type LockState,
  type PresenceState,
} from "../project-do-handlers"
import type { OutboxRawEvent } from "../project-do-types"

const emptyLocks = (): Map<string, LockState> => new Map()
const emptyPresence = (): Map<string, PresenceState> => new Map()

describe("parseProjectDoClientMessage", () => {
  it("parses focus.claim with leaseMs", () => {
    const m = parseProjectDoClientMessage(
      JSON.stringify({ t: "focus.claim", cellId: "c", leaseMs: 1000 }),
    )
    expect(m).toEqual({ t: "focus.claim", cellId: "c", leaseMs: 1000 })
  })
  it("parses focus.claim without leaseMs", () => {
    const m = parseProjectDoClientMessage(JSON.stringify({ t: "focus.claim", cellId: "c" }))
    expect(m).toEqual({ t: "focus.claim", cellId: "c" })
  })
  it("parses focus.renew + focus.release", () => {
    expect(
      parseProjectDoClientMessage(JSON.stringify({ t: "focus.renew", cellId: "c" })),
    ).toEqual({ t: "focus.renew", cellId: "c" })
    expect(
      parseProjectDoClientMessage(JSON.stringify({ t: "focus.release", cellId: "c" })),
    ).toEqual({ t: "focus.release", cellId: "c" })
  })
  it("parses outbox.event", () => {
    const ev: OutboxRawEvent = {
      id: "e",
      schemaVersion: 1,
      kind: "target.cell.commit",
      projectId: "p",
      fileId: "f",
      cellId: "c",
      parentId: "prev",
      author: "u",
      payload: { value: "x" },
      clientTs: 1,
    }
    const m = parseProjectDoClientMessage(JSON.stringify({ t: "outbox.event", event: ev }))
    expect(m?.t).toBe("outbox.event")
    if (m && m.t === "outbox.event") {
      expect(m.event.id).toBe("e")
    }
  })
  it("rejects malformed frames", () => {
    expect(parseProjectDoClientMessage("nope")).toBeNull()
    expect(parseProjectDoClientMessage(JSON.stringify({ t: "wat" }))).toBeNull()
    expect(parseProjectDoClientMessage(JSON.stringify({ t: "focus.claim" }))).toBeNull()
    expect(
      parseProjectDoClientMessage(JSON.stringify({ t: "outbox.event", event: null })),
    ).toBeNull()
  })
})

describe("applyFocusClaim", () => {
  it("claims when the cell is unheld and broadcasts lock.claimed + presence", () => {
    const r = applyFocusClaim(
      emptyLocks(),
      emptyPresence(),
      "alice",
      { t: "focus.claim", cellId: "c", leaseMs: 30_000 },
      1000,
    )
    expect(r.locks.get("c")).toEqual({
      cellId: "c",
      userId: "alice",
      expiresAt: 1000 + 30_000,
    })
    expect(r.presence.get("alice")?.focusedCell).toBe("c")
    expect(r.emit.find((m) => m.t === "lock.claimed")).toEqual({
      t: "lock.claimed",
      cellId: "c",
      by: { userId: "alice", ts: 1000 },
    })
    expect(r.emit.some((m) => m.t === "presence")).toBe(true)
    expect(r.emitTo).toHaveLength(0)
  })

  it("rejects when another user holds the unexpired lock — replies only to claimant", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "bob", expiresAt: 5_000 }],
    ])
    const r = applyFocusClaim(
      locks,
      emptyPresence(),
      "alice",
      { t: "focus.claim", cellId: "c" },
      2_000,
    )
    // Lock unchanged.
    expect(r.locks.get("c")?.userId).toBe("bob")
    expect(r.emit).toHaveLength(0)
    expect(r.emitTo).toHaveLength(1)
    expect(r.emitTo[0]).toMatchObject({
      t: "lock.claimed",
      cellId: "c",
      by: { userId: "bob" },
    })
  })

  it("treats an expired held lock as unheld", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "bob", expiresAt: 100 }],
    ])
    const r = applyFocusClaim(
      locks,
      emptyPresence(),
      "alice",
      { t: "focus.claim", cellId: "c" },
      5_000,
    )
    expect(r.locks.get("c")?.userId).toBe("alice")
    expect(r.emitTo).toHaveLength(0)
  })

  it("uses default lease when leaseMs omitted", () => {
    const r = applyFocusClaim(
      emptyLocks(),
      emptyPresence(),
      "alice",
      { t: "focus.claim", cellId: "c" },
      0,
    )
    expect(r.locks.get("c")?.expiresAt).toBe(PROJECT_DO_DEFAULT_LEASE_MS)
  })
})

describe("applyFocusRenew", () => {
  it("extends the lease for the holder", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 1_000 }],
    ])
    const r = applyFocusRenew(locks, emptyPresence(), "alice", { t: "focus.renew", cellId: "c" }, 5_000)
    expect(r.locks.get("c")?.expiresAt).toBe(5_000 + PROJECT_DO_DEFAULT_LEASE_MS)
  })
  it("is a no-op when called by a non-holder", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 1_000 }],
    ])
    const r = applyFocusRenew(locks, emptyPresence(), "bob", { t: "focus.renew", cellId: "c" }, 5_000)
    expect(r.locks.get("c")?.expiresAt).toBe(1_000)
  })
})

describe("applyFocusRelease", () => {
  it("releases the holder's lock + broadcasts lock.released + presence", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", focusedCell: "c", ts: 1 }],
    ])
    const r = applyFocusRelease(locks, presence, "alice", { t: "focus.release", cellId: "c" }, 6_000)
    expect(r.locks.has("c")).toBe(false)
    expect(r.presence.get("alice")?.focusedCell).toBeUndefined()
    expect(r.emit.some((m) => m.t === "lock.released")).toBe(true)
  })
  it("no-ops when caller is not the holder", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 5_000 }],
    ])
    const r = applyFocusRelease(locks, emptyPresence(), "bob", { t: "focus.release", cellId: "c" }, 6_000)
    expect(r.locks.has("c")).toBe(true)
    expect(r.emit).toHaveLength(0)
  })
})

describe("applyDisconnect", () => {
  it("drops presence + releases all locks the user held", () => {
    const locks = new Map<string, LockState>([
      ["a", { cellId: "a", userId: "alice", expiresAt: 5_000 }],
      ["b", { cellId: "b", userId: "alice", expiresAt: 5_000 }],
      ["c", { cellId: "c", userId: "bob", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", ts: 1 }],
      ["bob", { userId: "bob", ts: 1 }],
    ])
    const r = applyDisconnect(locks, presence, "alice", 9_000)
    expect(r.locks.has("a")).toBe(false)
    expect(r.locks.has("b")).toBe(false)
    expect(r.locks.has("c")).toBe(true)
    expect(r.presence.has("alice")).toBe(false)
    expect(r.presence.has("bob")).toBe(true)
    const released = r.emit.filter((m) => m.t === "lock.released")
    expect(released).toHaveLength(2)
  })
})

describe("sweepExpiredLeases", () => {
  it("drops expired leases + emits lock.released for each", () => {
    const locks = new Map<string, LockState>([
      ["a", { cellId: "a", userId: "alice", expiresAt: 1_000 }],
      ["b", { cellId: "b", userId: "bob", expiresAt: 100 }],
      ["c", { cellId: "c", userId: "carol", expiresAt: 9_999 }],
    ])
    const r = sweepExpiredLeases(locks, 5_000)
    expect(r.locks.has("a")).toBe(false)
    expect(r.locks.has("b")).toBe(false)
    expect(r.locks.has("c")).toBe(true)
    expect(r.emit).toHaveLength(2)
  })
})
