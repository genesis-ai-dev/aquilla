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
    // Only the claimant's row goes out — never the whole roster.
    expect(r.emit.find((m) => m.t === "presence.diff")).toEqual({
      t: "presence.diff",
      user: { userId: "alice", focusedCell: "c", ts: 1000 },
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
    expect(r.emit[0]).toEqual({
      t: "presence.diff",
      user: {
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
      ["alice", { userId: "alice", focusedCell: "cell-1", ts: 1 }],
      ["bob", { userId: "bob", focusedCell: "cell-9", ts: 1 }],
    ])
    const r = applyPresenceUpdate(
      presence,
      "alice",
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
          userId: "alice",
          focusedCell: "cell-1",
          selection: { side: "target", anchor: 3, head: 3 },
          ts: 2_000,
        },
      },
      {
        t: "presence.draft",
        userId: "alice",
        cellId: "cell-1",
        draftText: "In the beginning",
        ts: 2_000,
      },
    ])
  })

  it("moving the caret without changing the draft emits presence.diff only", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        userId: "alice",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 3, head: 3, draftText: "same" },
        ts: 1,
      }],
    ])
    const r = applyPresenceUpdate(
      presence,
      "alice",
      { t: "presence.update", selection: { side: "target", anchor: 4, head: 4, draftText: "same" } },
      2_000,
    )
    expect(r.emit.map((m) => m.t)).toEqual(["presence.diff"])
  })

  it("emits nothing when the update changes nothing", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        userId: "alice",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 3, head: 3, draftText: "same" },
        ts: 2_000,
      }],
    ])
    const r = applyPresenceUpdate(
      presence,
      "alice",
      { t: "presence.update", selection: { side: "target", anchor: 3, head: 3, draftText: "same" } },
      2_000,
    )
    expect(r.emit).toEqual([])
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

describe("presenceSnapshot", () => {
  it("returns the full roster with every draftText stripped (connect snapshot)", () => {
    const presence = new Map<string, PresenceState>([
      ["alice", {
        userId: "alice",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 0, head: 2, draftText: "x".repeat(10_000) },
        ts: 1,
      }],
      ["bob", { userId: "bob", currentFileId: "file-1", ts: 2 }],
    ])
    expect(presenceSnapshot(presence)).toEqual({
      t: "presence",
      users: [
        {
          userId: "alice",
          focusedCell: "cell-1",
          selection: { side: "target", anchor: 0, head: 2 },
          ts: 1,
        },
        { userId: "bob", currentFileId: "file-1", ts: 2 },
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
  it("releases the holder's lock + broadcasts lock.released + presence.diff", () => {
    const locks = new Map<string, LockState>([
      ["c", { cellId: "c", userId: "alice", expiresAt: 5_000 }],
    ])
    const presence = new Map<string, PresenceState>([
      ["alice", { userId: "alice", focusedCell: "c", ts: 1 }],
    ])
    const r = applyFocusRelease(locks, presence, "alice", { t: "focus.release", cellId: "c" }, 6_000)
    expect(r.locks.has("c")).toBe(false)
    expect(r.presence.get("alice")?.focusedCell).toBeUndefined()
    expect(r.emit.map((m) => m.t)).toEqual(["lock.released", "presence.diff"])
    expect(r.emit[1]).toEqual({
      t: "presence.diff",
      user: { userId: "alice", ts: 6_000 },
    })
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
    // Peers drop the row from a one-user frame; bob's row is not re-sent.
    expect(r.emit.at(-1)).toEqual({ t: "presence.left", userId: "alice" })
    expect(r.emit.some((m) => m.t === "presence")).toBe(false)
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
    expect(r.emit).toHaveLength(0)
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
      user: { userId: "bob", currentFileId: "file-1", ts: 5_000 },
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
