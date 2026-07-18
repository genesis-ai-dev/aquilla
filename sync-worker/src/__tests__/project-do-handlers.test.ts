import { describe, it, expect } from "vitest"
import {
  applyDisconnect,
  applyFocusClaim,
  applyFocusRelease,
  applyFocusRenew,
  applyPresenceUpdate,
  parseProjectDoClientMessage,
  PROJECT_DO_DEFAULT_LEASE_MS,
  sweepExpiredLeases,
  unpackBroadcastBody,
  type LockState,
  type PresenceState,
  type ProjectDoServerMessage,
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
  it("parses presence.update with file, focus, and target selection", () => {
    const m = parseProjectDoClientMessage(JSON.stringify({
      t: "presence.update",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: 2, head: 5, draftText: "hello" },
    }))
    expect(m).toEqual({
      t: "presence.update",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: 2, head: 5, draftText: "hello" },
    })
  })
  it("rejects oversized presence drafts", () => {
    expect(parseProjectDoClientMessage(JSON.stringify({
      t: "presence.update",
      selection: { side: "target", anchor: 0, head: 0, draftText: "x".repeat(16_385) },
    }))).toBeNull()
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

describe("applyPresenceUpdate", () => {
  it("merges current file and target selection into an already-focused presence", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", focusedCell: "cell-1", ts: 1 }],
    ])
    const r = applyPresenceUpdate(
      presence,
      "alice",
      {
        t: "presence.update",
        currentFileId: "file-1",
        selection: { side: "target", anchor: 1, head: 4 },
      },
      1_000,
    )
    expect(r.presence.get("alice")).toEqual({
      userId: "alice",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: 1, head: 4 },
      ts: 1_000,
    })
    expect(r.emit).toHaveLength(1)
    expect(r.emit[0]?.t).toBe("presence")
  })

  it("does not grant focus from presence.update alone", () => {
    const r = applyPresenceUpdate(
      emptyPresence(),
      "alice",
      { t: "presence.update", currentFileId: "file-1", focusedCell: "cell-1" },
      1_000,
    )
    expect(r.presence.get("alice")).toEqual({
      userId: "alice",
      currentFileId: "file-1",
      ts: 1_000,
    })
  })

  it("clears focus and selection while preserving current file", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 1, head: 4 },
        ts: 1,
      }],
    ])
    const r = applyPresenceUpdate(
      presence,
      "alice",
      { t: "presence.update", focusedCell: null, selection: null },
      2_000,
    )
    expect(r.presence.get("alice")).toEqual({
      userId: "alice",
      currentFileId: "file-1",
      ts: 2_000,
    })
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
  it("drops presence + releases all locks the user held (single connection)", () => {
    const locks = new Map<string, LockState>([
      ["a", { cellId: "a", userId: "alice", expiresAt: 5_000 }],
      ["b", { cellId: "b", userId: "alice", expiresAt: 5_000 }],
      ["c", { cellId: "c", userId: "bob", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", ts: 1 }],
      ["bob", { userId: "bob", ts: 1 }],
    ])
    // remainingConnectionsForUser=0 (default) — last connection, release everything
    const r = applyDisconnect(locks, presence, "alice", 9_000)
    expect(r.locks.has("a")).toBe(false)
    expect(r.locks.has("b")).toBe(false)
    expect(r.locks.has("c")).toBe(true)
    expect(r.presence.has("alice")).toBe(false)
    expect(r.presence.has("bob")).toBe(true)
    const released = r.emit.filter((m) => m.t === "lock.released")
    expect(released).toHaveLength(2)
  })

  // RACE-6: closing one tab must NOT release locks/presence when another tab
  // for the same user is still connected.
  it("multi-tab: closing tab B preserves tab A's locks and presence", () => {
    const locks = new Map<string, LockState>([
      ["cell-1", { cellId: "cell-1", userId: "alice", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", focusedCell: "cell-1", ts: 1 }],
    ])
    // remainingConnectionsForUser=1 — tab A still connected
    const r = applyDisconnect(locks, presence, "alice", 9_000, 1)
    // Lock must survive
    expect(r.locks.has("cell-1")).toBe(true)
    expect(r.locks.get("cell-1")?.userId).toBe("alice")
    // Presence must survive
    expect(r.presence.has("alice")).toBe(true)
    // No broadcasts
    expect(r.emit.filter((m) => m.t === "lock.released")).toHaveLength(0)
  })

  it("multi-tab: closing the last tab releases all locks and presence", () => {
    const locks = new Map<string, LockState>([
      ["cell-1", { cellId: "cell-1", userId: "alice", expiresAt: 5_000 }],
      ["cell-2", { cellId: "cell-2", userId: "alice", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", focusedCell: "cell-1", ts: 1 }],
    ])
    // remainingConnectionsForUser=0 — this was the last tab
    const r = applyDisconnect(locks, presence, "alice", 9_000, 0)
    expect(r.locks.has("cell-1")).toBe(false)
    expect(r.locks.has("cell-2")).toBe(false)
    expect(r.presence.has("alice")).toBe(false)
    const released = r.emit.filter((m) => m.t === "lock.released")
    expect(released).toHaveLength(2)
  })

  it("multi-tab: claim from tab A survives tab B closing", () => {
    // Simulate: alice claims cell from tab A, then tab B disconnects.
    const now = 1_000
    // 1. Tab A claims cell
    const claimResult = applyFocusClaim(
      emptyLocks(),
      emptyPresence(),
      "alice",
      { t: "focus.claim", cellId: "cell-x" },
      now,
    )
    expect(claimResult.locks.get("cell-x")?.userId).toBe("alice")

    // 2. Tab B disconnects with remaining=1 (tab A still open)
    const disconnectResult = applyDisconnect(
      claimResult.locks,
      claimResult.presence,
      "alice",
      now + 500,
      1,
    )
    // Lock survives
    expect(disconnectResult.locks.get("cell-x")?.userId).toBe("alice")
    expect(disconnectResult.presence.has("alice")).toBe(true)

    // 3. Tab A finally closes (remaining=0)
    const finalDisconnect = applyDisconnect(
      disconnectResult.locks,
      disconnectResult.presence,
      "alice",
      now + 1_000,
      0,
    )
    expect(finalDisconnect.locks.has("cell-x")).toBe(false)
    expect(finalDisconnect.presence.has("alice")).toBe(false)
  })
})

describe("sweepExpiredLeases", () => {
  it("drops expired leases + emits lock.released for each", () => {
    const locks = new Map<string, LockState>([
      ["a", { cellId: "a", userId: "alice", expiresAt: 1_000 }],
      ["b", { cellId: "b", userId: "bob", expiresAt: 100 }],
      ["c", { cellId: "c", userId: "carol", expiresAt: 9_999 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", focusedCell: "a", currentFileId: "file-1", ts: 1 }],
      ["bob", {
        userId: "bob",
        focusedCell: "b",
        currentFileId: "file-1",
        selection: { side: "target", anchor: 0, head: 2 },
        ts: 1,
      }],
      ["carol", { userId: "carol", focusedCell: "c", currentFileId: "file-2", ts: 1 }],
    ])
    const r = sweepExpiredLeases(locks, presence, 5_000)
    expect(r.locks.has("a")).toBe(false)
    expect(r.locks.has("b")).toBe(false)
    expect(r.locks.has("c")).toBe(true)
    expect(r.presence.get("alice")).toEqual({
      userId: "alice",
      currentFileId: "file-1",
      ts: 5_000,
    })
    expect(r.presence.get("bob")).toEqual({
      userId: "bob",
      currentFileId: "file-1",
      ts: 5_000,
    })
    expect(r.presence.get("carol")?.focusedCell).toBe("c")
    expect(r.emit).toHaveLength(2)
  })
})

describe("unpackBroadcastBody", () => {
  // PERF-8: POST /events batches all of a project's frames into one
  // __broadcast subrequest. The DO must unpack BOTH shapes — old workers
  // (rolling deploy) and archive-broadcast still send single-message bodies.
  const applied = (id: string): ProjectDoServerMessage => ({
    t: "event.applied",
    id,
    kind: "target.cell.commit",
    project: "p1",
    file: "f1",
    cell: "c1",
    by: "alice",
  })

  it("treats a legacy single-message body as one frame", () => {
    expect(unpackBroadcastBody(applied("e1"))).toEqual([applied("e1")])
  })

  it("unpacks a broadcast.batch envelope into per-message frames", () => {
    const body = { t: "broadcast.batch", messages: [applied("e1"), applied("e2")] }
    expect(unpackBroadcastBody(body)).toEqual([applied("e1"), applied("e2")])
  })

  it("yields no frames for a malformed envelope instead of leaking it to clients", () => {
    expect(unpackBroadcastBody({ t: "broadcast.batch", messages: "nope" })).toEqual([])
    expect(unpackBroadcastBody({ t: "broadcast.batch" })).toEqual([])
  })

  it("preserves the old handler's leniency for non-envelope bodies", () => {
    // The old handler cast-and-broadcast any JSON value; callers are trusted
    // internal workers, so unknown shapes pass through unchanged.
    const archived = { t: "project.archived", project: "p1", archivedAt: null, deletedBy: null }
    expect(unpackBroadcastBody(archived)).toEqual([archived])
  })
})
