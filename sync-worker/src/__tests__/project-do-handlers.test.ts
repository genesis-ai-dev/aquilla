import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import {
  applyDisconnect,
  applyFocusClaim,
  applyFocusRelease,
  applyFocusRenew,
  applyPresenceUpdate,
  parseProjectDoClientMessage,
  PresenceDraftThrottle,
  presenceSnapshot,
  PRESENCE_DRAFT_THROTTLE_MS,
  resolveConnId,
  PROJECT_DO_DEFAULT_LEASE_MS,
  sweepExpiredLeases,
  unpackBroadcastBody,
  type LockState,
  type PresenceState,
  type ProjectDoServerMessage,
  type ServerPresenceDraft,
} from "../project-do-handlers"
import type { OutboxRawEvent } from "../project-do-types"

const emptyLocks = (): Map<string, LockState> => new Map()
const emptyPresence = (): Map<string, PresenceState> => new Map()
/** Single-tab identity: connId == userId keeps the map keys readable. */
const who = (name: string) => ({ connId: name, userId: name })

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
  it("claims when the cell is unheld and broadcasts lock.claimed + presence.diff", () => {
    const r = applyFocusClaim(
      emptyLocks(),
      emptyPresence(),
      who("alice"),
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
    // Only the claimant's row goes out — never the whole roster.
    expect(r.emit.find((m) => m.t === "presence.diff")).toEqual({
      t: "presence.diff",
      user: { connId: "alice", userId: "alice", focusedCell: "c", ts: 1000 },
    })
    expect(r.emit.some((m) => m.t === "presence")).toBe(false)
    expect(r.emitTo).toHaveLength(0)
  })

  it("rejects when another user holds the unexpired lock — replies only to claimant", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "bob", expiresAt: 5_000 }],
    ])
    const r = applyFocusClaim(
      locks,
      emptyPresence(),
      who("alice"),
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
      who("alice"),
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
      who("alice"),
      { t: "focus.claim", cellId: "c" },
      0,
    )
    expect(r.locks.get("c")?.expiresAt).toBe(PROJECT_DO_DEFAULT_LEASE_MS)
  })
})

describe("applyPresenceUpdate", () => {
  it("merges current file and target selection into an already-focused presence", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", { connId: "alice", userId: "alice", focusedCell: "cell-1", ts: 1 }],
    ])
    const r = applyPresenceUpdate(
      presence,
      who("alice"),
      {
        t: "presence.update",
        currentFileId: "file-1",
        selection: { side: "target", anchor: 1, head: 4 },
      },
      1_000,
    )
    expect(r.presence.get("alice")).toEqual({
      connId: "alice",
      userId: "alice",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: 1, head: 4 },
      ts: 1_000,
    })
    expect(r.emit).toHaveLength(1)
    expect(r.emit[0]).toEqual({
      t: "presence.diff",
      user: {
        connId: "alice",
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 1, head: 4 },
        ts: 1_000,
      },
    })
  })

  // Full-roster rebroadcasts made every keystroke cost O(users × 16 KB) for
  // every peer; the diff carries only the changed user and the draft text is
  // split off into its own (rate-limited) frame.
  it("emits one draft-free presence.diff plus one presence.draft when draftText is set", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", { connId: "alice", userId: "alice", focusedCell: "cell-1", ts: 1 }],
      ["bob", { connId: "bob", userId: "bob", focusedCell: "cell-9", ts: 1 }],
    ])
    const r = applyPresenceUpdate(
      presence,
      who("alice"),
      {
        t: "presence.update",
        selection: { side: "target", anchor: 3, head: 3, draftText: "In the beginning" },
      },
      2_000,
    )
    // The server keeps the draft so a later identical update is a no-op…
    expect(r.presence.get("alice")?.selection?.draftText).toBe("In the beginning")
    // …but the diff frame never carries it.
    expect(r.emit).toEqual([
      {
        t: "presence.diff",
        user: {
          connId: "alice",
          userId: "alice",
          focusedCell: "cell-1",
          selection: { side: "target", anchor: 3, head: 3 },
          ts: 2_000,
        },
      },
      {
        t: "presence.draft",
        userId: "alice",
        connId: "alice",
        cellId: "cell-1",
        draftText: "In the beginning",
        ts: 2_000,
      },
    ])
  })

  it("moving the caret without changing the draft emits presence.diff only", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        connId: "alice",
        userId: "alice",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 3, head: 3, draftText: "same" },
        ts: 1,
      }],
    ])
    const r = applyPresenceUpdate(
      presence,
      who("alice"),
      { t: "presence.update", selection: { side: "target", anchor: 4, head: 4, draftText: "same" } },
      2_000,
    )
    expect(r.emit.map((m) => m.t)).toEqual(["presence.diff"])
  })

  it("emits nothing when the update changes nothing", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        connId: "alice",
        userId: "alice",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 3, head: 3, draftText: "same" },
        ts: 2_000,
      }],
    ])
    const r = applyPresenceUpdate(
      presence,
      who("alice"),
      { t: "presence.update", selection: { side: "target", anchor: 3, head: 3, draftText: "same" } },
      2_000,
    )
    expect(r.emit).toEqual([])
  })

  it("drops an unchanged repeat even when its timestamp moved on", () => {
    // Heartbeat-style re-sends and resumed tabs replay the same state with a
    // fresh ts; fanning each out as presence.diff is pure bandwidth waste.
    const presence = new Map<string, PresenceState>([
      ["alice", {
        connId: "alice",
        userId: "alice",
        currentFileId: "file-1",
        viewingCell: "cell-1",
        ts: 1_000,
      }],
    ])
    const r = applyPresenceUpdate(
      presence,
      who("alice"),
      { t: "presence.update", currentFileId: "file-1", viewingCell: "cell-1" },
      5_000,
    )
    expect(r.emit).toEqual([])
  })

  it("sets and clears viewingCell without a lock, and broadcasts a presence.diff", () => {
    // A viewer/reviewer, or a contributor whose claim was denied, still shows
    // up on the row they are looking at — viewingCell is not lease-gated.
    const r1 = applyPresenceUpdate(
      emptyPresence(),
      who("viewer"),
      { t: "presence.update", currentFileId: "file-1", viewingCell: "cell-7" },
      1_000,
    )
    expect(r1.presence.get("viewer")).toEqual({
      connId: "viewer",
      userId: "viewer",
      currentFileId: "file-1",
      viewingCell: "cell-7",
      ts: 1_000,
    })
    expect(r1.emit).toEqual([
      { t: "presence.diff", user: { connId: "viewer", userId: "viewer", currentFileId: "file-1", viewingCell: "cell-7", ts: 1_000 } },
    ])
    const r2 = applyPresenceUpdate(r1.presence, who("viewer"), { t: "presence.update", viewingCell: null }, 2_000)
    expect(r2.presence.get("viewer")).toEqual({ connId: "viewer", userId: "viewer", currentFileId: "file-1", ts: 2_000 })
    expect(r2.emit.map((m) => m.t)).toEqual(["presence.diff"])
  })

  it("keeps viewingCell when the lease is released or swept", () => {
    const claimed = applyFocusClaim(
      emptyLocks(),
      new Map<string, PresenceState>([["alice", { connId: "alice", userId: "alice", viewingCell: "cell-1", ts: 1 }]]),
      who("alice"),
      { t: "focus.claim", cellId: "cell-1", leaseMs: 1_000 },
      1_000,
    )
    expect(claimed.presence.get("alice")).toMatchObject({ focusedCell: "cell-1", viewingCell: "cell-1" })
    const released = applyFocusRelease(claimed.locks, claimed.presence, who("alice"), { t: "focus.release", cellId: "cell-1" }, 2_000)
    expect(released.presence.get("alice")).toEqual({ connId: "alice", userId: "alice", viewingCell: "cell-1", ts: 2_000 })
    const swept = sweepExpiredLeases(claimed.locks, claimed.presence, 10_000)
    expect(swept.presence.get("alice")).toEqual({ connId: "alice", userId: "alice", viewingCell: "cell-1", ts: 10_000 })
  })

  it("does not grant focus from presence.update alone", () => {
    const r = applyPresenceUpdate(
      emptyPresence(),
      who("alice"),
      { t: "presence.update", currentFileId: "file-1", focusedCell: "cell-1" },
      1_000,
    )
    expect(r.presence.get("alice")).toEqual({
      connId: "alice",
      userId: "alice",
      currentFileId: "file-1",
      ts: 1_000,
    })
  })

  it("clears focus and selection while preserving current file", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        connId: "alice",
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 1, head: 4 },
        ts: 1,
      }],
    ])
    const r = applyPresenceUpdate(
      presence,
      who("alice"),
      { t: "presence.update", focusedCell: null, selection: null },
      2_000,
    )
    expect(r.presence.get("alice")).toEqual({
      connId: "alice",
      userId: "alice",
      currentFileId: "file-1",
      ts: 2_000,
    })
  })
})

describe("presenceSnapshot", () => {
  it("returns the full roster with every draftText stripped (connect snapshot)", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        connId: "alice",
        userId: "alice",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 0, head: 2, draftText: "x".repeat(10_000) },
        ts: 1,
      }],
      ["bob", { connId: "bob", userId: "bob", currentFileId: "file-1", ts: 2 }],
    ])
    expect(presenceSnapshot(presence)).toEqual({
      t: "presence",
      users: [
        {
          connId: "alice",
          userId: "alice",
          focusedCell: "cell-1",
          selection: { side: "target", anchor: 0, head: 2 },
          ts: 1,
        },
        { connId: "bob", userId: "bob", currentFileId: "file-1", ts: 2 },
      ],
    })
  })
})

describe("PresenceDraftThrottle", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const draft = (userId: string, draftText: string, ts: number): ServerPresenceDraft => ({
    t: "presence.draft",
    userId,
    connId: userId,
    cellId: "cell-1",
    draftText,
    ts,
  })

  it("sends the first draft immediately and only the LATEST of those inside the window", () => {
    const sent: ServerPresenceDraft[] = []
    const throttle = new PresenceDraftThrottle((f) => sent.push(f))
    throttle.push(draft("alice", "a", 1))
    throttle.push(draft("alice", "ab", 2))
    throttle.push(draft("alice", "abc", 3))
    expect(sent.map((f) => f.draftText)).toEqual(["a"])
    vi.advanceTimersByTime(PRESENCE_DRAFT_THROTTLE_MS - 1)
    expect(sent).toHaveLength(1)
    vi.advanceTimersByTime(1)
    // "ab" was superseded inside the window and never goes out.
    expect(sent.map((f) => f.draftText)).toEqual(["a", "abc"])
    // A quiet window afterwards closes the throttle; the next draft is immediate again.
    vi.advanceTimersByTime(PRESENCE_DRAFT_THROTTLE_MS)
    throttle.push(draft("alice", "abcd", 4))
    expect(sent.map((f) => f.draftText)).toEqual(["a", "abc", "abcd"])
  })

  it("rate-limits per user, not globally", () => {
    const sent: ServerPresenceDraft[] = []
    const throttle = new PresenceDraftThrottle((f) => sent.push(f))
    throttle.push(draft("alice", "a", 1))
    throttle.push(draft("bob", "b", 1))
    expect(sent.map((f) => f.userId)).toEqual(["alice", "bob"])
  })

  it("clear() drops the held draft on disconnect", () => {
    const sent: ServerPresenceDraft[] = []
    const throttle = new PresenceDraftThrottle((f) => sent.push(f))
    throttle.push(draft("alice", "a", 1))
    throttle.push(draft("alice", "ab", 2))
    throttle.clear("alice")
    vi.advanceTimersByTime(PRESENCE_DRAFT_THROTTLE_MS * 2)
    expect(sent.map((f) => f.draftText)).toEqual(["a"])
  })
})

describe("applyFocusRenew", () => {
  it("extends the lease for the holder", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 1_000 }],
    ])
    const r = applyFocusRenew(locks, emptyPresence(), who("alice"), { t: "focus.renew", cellId: "c" }, 5_000)
    expect(r.locks.get("c")?.expiresAt).toBe(5_000 + PROJECT_DO_DEFAULT_LEASE_MS)
  })
  it("is a no-op when called by a non-holder", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 1_000 }],
    ])
    const r = applyFocusRenew(locks, emptyPresence(), who("bob"), { t: "focus.renew", cellId: "c" }, 5_000)
    expect(r.locks.get("c")?.expiresAt).toBe(1_000)
  })
})

describe("applyFocusRelease", () => {
  it("releases the holder's lock + broadcasts lock.released + presence.diff", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { connId: "alice", userId: "alice", focusedCell: "c", ts: 1 }],
    ])
    const r = applyFocusRelease(locks, presence, who("alice"), { t: "focus.release", cellId: "c" }, 6_000)
    expect(r.locks.has("c")).toBe(false)
    expect(r.presence.get("alice")?.focusedCell).toBeUndefined()
    expect(r.emit.map((m) => m.t)).toEqual(["lock.released", "presence.diff"])
    expect(r.emit[1]).toEqual({
      t: "presence.diff",
      user: { connId: "alice", userId: "alice", ts: 6_000 },
    })
  })
  it("no-ops when caller is not the holder", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 5_000 }],
    ])
    const r = applyFocusRelease(locks, emptyPresence(), who("bob"), { t: "focus.release", cellId: "c" }, 6_000)
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
      ["alice", { connId: "alice", userId: "alice", ts: 1 }],
      ["bob", { connId: "bob", userId: "bob", ts: 1 }],
    ])
    // remainingConnectionsForUser=0 (default) — last connection, release everything
    const r = applyDisconnect(locks, presence, who("alice"), 9_000)
    expect(r.locks.has("a")).toBe(false)
    expect(r.locks.has("b")).toBe(false)
    expect(r.locks.has("c")).toBe(true)
    expect(r.presence.has("alice")).toBe(false)
    expect(r.presence.has("bob")).toBe(true)
    const released = r.emit.filter((m) => m.t === "lock.released")
    expect(released).toHaveLength(2)
    // Peers drop the row from a one-user frame; bob's row is not re-sent.
    expect(r.emit.at(-1)).toEqual({ t: "presence.left", userId: "alice", connId: "alice" })
    expect(r.emit.some((m) => m.t === "presence")).toBe(false)
  })

  // RACE-6: closing one tab must NOT release locks when another tab for the
  // same user is still connected. Presence, however, is per connection: the
  // closing tab's row goes away so peers stop seeing a ghost, while tab A's
  // row (same userId, different connId) stays.
  it("multi-tab: closing tab B preserves tab A's lock and presence row, drops only B's row", () => {
    const locks = new Map<string, LockState>([
      ["cell-1", { cellId: "cell-1", userId: "alice", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["tab-a", { connId: "tab-a", userId: "alice", focusedCell: "cell-1", ts: 1 }],
      ["tab-b", { connId: "tab-b", userId: "alice", viewingCell: "cell-2", ts: 1 }],
    ])
    // remainingConnectionsForUser=1 — tab A still connected
    const r = applyDisconnect(locks, presence, { connId: "tab-b", userId: "alice" }, 9_000, 1)
    expect(r.locks.get("cell-1")?.userId).toBe("alice")
    expect(r.presence.get("tab-a")?.focusedCell).toBe("cell-1")
    expect(r.presence.has("tab-b")).toBe(false)
    expect(r.emit).toEqual([{ t: "presence.left", userId: "alice", connId: "tab-b" }])
  })

  it("multi-tab: closing the last tab releases all locks and presence", () => {
    const locks = new Map<string, LockState>([
      ["cell-1", { cellId: "cell-1", userId: "alice", expiresAt: 5_000 }],
      ["cell-2", { cellId: "cell-2", userId: "alice", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { connId: "alice", userId: "alice", focusedCell: "cell-1", ts: 1 }],
    ])
    // remainingConnectionsForUser=0 — this was the last tab
    const r = applyDisconnect(locks, presence, who("alice"), 9_000, 0)
    expect(r.locks.has("cell-1")).toBe(false)
    expect(r.locks.has("cell-2")).toBe(false)
    expect(r.presence.has("alice")).toBe(false)
    const released = r.emit.filter((m) => m.t === "lock.released")
    expect(released).toHaveLength(2)
  })

  it("multi-tab: claim from tab A survives tab B closing", () => {
    // Simulate: alice claims cell from tab A, then tab B disconnects.
    const now = 1_000
    const tabA = { connId: "tab-a", userId: "alice" }
    const tabB = { connId: "tab-b", userId: "alice" }
    // 1. Tab A claims cell
    const claimResult = applyFocusClaim(
      emptyLocks(),
      new Map<string, PresenceState>([["tab-b", { ...tabB, ts: 1 }]]),
      tabA,
      { t: "focus.claim", cellId: "cell-x" },
      now,
    )
    expect(claimResult.locks.get("cell-x")?.userId).toBe("alice")

    // 2. Tab B disconnects with remaining=1 (tab A still open)
    const disconnectResult = applyDisconnect(
      claimResult.locks,
      claimResult.presence,
      tabB,
      now + 500,
      1,
    )
    // Lock survives
    expect(disconnectResult.locks.get("cell-x")?.userId).toBe("alice")
    expect(disconnectResult.presence.get("tab-a")?.focusedCell).toBe("cell-x")
    expect(disconnectResult.presence.has("tab-b")).toBe(false)

    // 3. Tab A finally closes (remaining=0)
    const finalDisconnect = applyDisconnect(
      disconnectResult.locks,
      disconnectResult.presence,
      tabA,
      now + 1_000,
      0,
    )
    expect(finalDisconnect.locks.has("cell-x")).toBe(false)
    expect(finalDisconnect.presence.size).toBe(0)
  })
})

// Presence is keyed per CONNECTION so two tabs — or two people sharing one
// test account — never overwrite each other's row and each sees the other.
describe("per-connection presence for one user", () => {
  const tabA = { connId: "tab-a", userId: "alice" }
  const tabB = { connId: "tab-b", userId: "alice" }

  it("two connections of one user are two roster rows in the snapshot", () => {
    const r1 = applyPresenceUpdate(emptyPresence(), tabA, { t: "presence.update", viewingCell: "cell-1" }, 1)
    const r2 = applyPresenceUpdate(r1.presence, tabB, { t: "presence.update", viewingCell: "cell-2" }, 2)
    expect(r1.presence.get("tab-a")?.viewingCell).toBe("cell-1")
    expect(presenceSnapshot(r2.presence).users).toEqual([
      { connId: "tab-a", userId: "alice", viewingCell: "cell-1", ts: 1 },
      { connId: "tab-b", userId: "alice", viewingCell: "cell-2", ts: 2 },
    ])
    // The diff for tab B never touches tab A's row.
    expect(r2.emit).toEqual([
      { t: "presence.diff", user: { connId: "tab-b", userId: "alice", viewingCell: "cell-2", ts: 2 } },
    ])
  })

  it("focus.claim from a second tab of the same user is granted (locks stay per user)", () => {
    const a = applyFocusClaim(emptyLocks(), emptyPresence(), tabA, { t: "focus.claim", cellId: "c" }, 1)
    const b = applyFocusClaim(a.locks, a.presence, tabB, { t: "focus.claim", cellId: "c" }, 2)
    expect(b.emitTo).toHaveLength(0)
    expect(b.locks.get("c")?.userId).toBe("alice")
    expect(b.presence.get("tab-a")?.focusedCell).toBe("c")
    expect(b.presence.get("tab-b")?.focusedCell).toBe("c")
  })

  it("focus.release from tab B clears only tab B's row; tab A keeps focusedCell for its re-claim", () => {
    const a = applyFocusClaim(emptyLocks(), emptyPresence(), tabA, { t: "focus.claim", cellId: "c" }, 1)
    const b = applyFocusClaim(a.locks, a.presence, tabB, { t: "focus.claim", cellId: "c" }, 2)
    const r = applyFocusRelease(b.locks, b.presence, tabB, { t: "focus.release", cellId: "c" }, 3)
    expect(r.locks.has("c")).toBe(false)
    expect(r.presence.get("tab-a")?.focusedCell).toBe("c")
    expect(r.presence.get("tab-b")?.focusedCell).toBeUndefined()
    expect(r.emit).toEqual([
      { t: "lock.released", cellId: "c", by: { userId: "alice", ts: 3 } },
      { t: "presence.diff", user: { connId: "tab-b", userId: "alice", ts: 3 } },
    ])
  })

  it("lease sweep clears focusedCell on every connection of the lock's user", () => {
    const a = applyFocusClaim(emptyLocks(), emptyPresence(), tabA, { t: "focus.claim", cellId: "c", leaseMs: 100 }, 1)
    const b = applyFocusClaim(a.locks, a.presence, tabB, { t: "focus.claim", cellId: "c", leaseMs: 100 }, 2)
    const r = sweepExpiredLeases(b.locks, b.presence, 1_000)
    expect(r.presence.get("tab-a")?.focusedCell).toBeUndefined()
    expect(r.presence.get("tab-b")?.focusedCell).toBeUndefined()
    expect(r.emit.filter((m) => m.t === "presence.diff")).toHaveLength(2)
  })

  it("presence.draft carries connId and is throttled per connection", () => {
    const sent: ServerPresenceDraft[] = []
    const throttle = new PresenceDraftThrottle((f) => sent.push(f))
    const a = applyFocusClaim(emptyLocks(), emptyPresence(), tabA, { t: "focus.claim", cellId: "c" }, 1)
    const b = applyFocusClaim(a.locks, a.presence, tabB, { t: "focus.claim", cellId: "c" }, 2)
    const ua = applyPresenceUpdate(b.presence, tabA, { t: "presence.update", selection: { side: "target", anchor: 0, head: 0, draftText: "a" } }, 3)
    const ub = applyPresenceUpdate(ua.presence, tabB, { t: "presence.update", selection: { side: "target", anchor: 0, head: 0, draftText: "b" } }, 4)
    for (const m of [...ua.emit, ...ub.emit]) if (m.t === "presence.draft") throttle.push(m)
    expect(sent.map((f) => [f.connId, f.draftText])).toEqual([["tab-a", "a"], ["tab-b", "b"]])
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
      ["alice", { connId: "alice", userId: "alice", focusedCell: "a", currentFileId: "file-1", ts: 1 }],
      ["bob", {
        connId: "bob",
        userId: "bob",
        focusedCell: "b",
        currentFileId: "file-1",
        selection: { side: "target", anchor: 0, head: 2 },
        ts: 1,
      }],
      ["carol", { connId: "carol", userId: "carol", focusedCell: "c", currentFileId: "file-2", ts: 1 }],
    ])
    const r = sweepExpiredLeases(locks, presence, 5_000)
    expect(r.locks.has("a")).toBe(false)
    expect(r.locks.has("b")).toBe(false)
    expect(r.locks.has("c")).toBe(true)
    expect(r.presence.get("alice")).toEqual({
      connId: "alice",
      userId: "alice",
      currentFileId: "file-1",
      ts: 5_000,
    })
    expect(r.presence.get("bob")).toEqual({
      connId: "bob",
      userId: "bob",
      currentFileId: "file-1",
      ts: 5_000,
    })
    expect(r.presence.get("carol")?.focusedCell).toBe("c")
    // lock.released + presence.diff per expired lease whose holder was
    // focused on it; the diff carries the cleared row, never a draft.
    expect(r.emit.map((m) => m.t)).toEqual([
      "lock.released",
      "presence.diff",
      "lock.released",
      "presence.diff",
    ])
    expect(r.emit[3]).toEqual({
      t: "presence.diff",
      user: { connId: "bob", userId: "bob", currentFileId: "file-1", ts: 5_000 },
    })
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

describe("unpackBroadcastBody — additive event.applied fields", () => {
  // POST /events now inlines `serverSeq` + the cell's projected `rows` on
  // event.applied. The DO relays frames as-is (JSON.stringify of the unpacked
  // message), so the only place a field could be dropped is here — pin it.
  const enriched = (id: string): ProjectDoServerMessage => ({
    t: "event.applied",
    id,
    kind: "target.cell.commit",
    project: "p1",
    file: "f1",
    cell: "c1",
    by: "alice",
    serverSeq: 42,
    rows: [
      {
        cellId: "c1",
        side: "target",
        targetLang: "",
        value: "hello",
        valueHtml: null,
        type: null,
        canonicalRef: null,
        anchorCellId: null,
        eventId: id,
        sourceEventId: null,
        lastEditor: "alice",
        lastEditAt: 1,
        validated: false,
        aiDrafted: false,
        aiDraft: null,
        wordCount: 1,
        endorsementCount: 0,
        startMs: null,
        endMs: null,
        medium: null,
        sequenceIndex: null,
        transcription: null,
        cameraState: null,
        metadata: null,
      },
    ],
  })

  it("passes serverSeq and rows through untouched on a single-message body", () => {
    const [frame] = unpackBroadcastBody(enriched("e1"))
    expect(frame).toEqual(enriched("e1"))
    // The DO sends JSON.stringify(frame) — nothing may be lost on the wire.
    expect(JSON.parse(JSON.stringify(frame))).toEqual(enriched("e1"))
  })

  it("passes serverSeq and rows through untouched inside a broadcast.batch envelope", () => {
    const body = { t: "broadcast.batch", messages: [enriched("e1"), enriched("e2")] }
    expect(unpackBroadcastBody(body)).toEqual([enriched("e1"), enriched("e2")])
  })
})

describe("resolveConnId", () => {
  const live = new Map<string, { connId: string }>([["ws1", { connId: "client-conn-0001" }]])
  it("accepts a well-formed client connId that no live socket holds", () => {
    expect(resolveConnId("client-conn-0002", live)).toBe("client-conn-0002")
  })
  it("mints a server id for old clients that send none, and for malformed or colliding ids", () => {
    const uuid = /^[0-9a-f-]{36}$/
    expect(resolveConnId(null, live)).toMatch(uuid)
    expect(resolveConnId("bad id!", live)).toMatch(uuid)
    expect(resolveConnId("short", live)).toMatch(uuid)
    expect(resolveConnId("client-conn-0001", live)).toMatch(uuid)
  })
})
