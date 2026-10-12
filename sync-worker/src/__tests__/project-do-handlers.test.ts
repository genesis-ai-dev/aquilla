import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import {
  applyDisconnect,
  applyFocusClaim,
  applyFocusRelease,
  applyFocusRenew,
  applyPresenceUpdate,
  parseProjectDoClientMessage,
  boundPresenceDraftText,
  mergePresenceUpdate,
  PresenceFloodGuard,
  PresenceTier2Batcher,
  presenceFrameOwnerConnId,
  presenceSnapshot,
  PRESENCE_FLOOD_BURST,
  PRESENCE_FLOOD_REFILL_PER_SEC,
  PRESENCE_HEARTBEAT_TTL_MS,
  PRESENCE_TIER2_TICK_MS,
  PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH,
  PROJECT_DO_PRESENCE_DRAFT_WIRE_MAX,
  resolveConnId,
  selectStaleConnections,
  PROJECT_DO_DEFAULT_LEASE_MS,
  sweepExpiredLeases,
  sweepOrphanedPresence,
  unpackBroadcastBody,
  type ClientPresenceUpdate,
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
  it("parses a heartbeat ping, keeping a numeric ts to echo", () => {
    expect(parseProjectDoClientMessage(JSON.stringify({ t: "ping", ts: 42 }))).toEqual({ t: "ping", ts: 42 })
    expect(parseProjectDoClientMessage(JSON.stringify({ t: "ping" }))).toEqual({ t: "ping" })
    expect(parseProjectDoClientMessage(JSON.stringify({ t: "ping", ts: "x" }))).toEqual({ t: "ping" })
  })
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

describe("PresenceTier2Batcher (AQU-1831 — batched per tick)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const patch = (viewingCell: string): ClientPresenceUpdate => ({
    t: "presence.update",
    viewingCell,
  })

  it("applies the first update immediately and only the LATEST of those inside the tick", () => {
    const applied: Array<[string, ClientPresenceUpdate]> = []
    const batcher = new PresenceTier2Batcher((connId, msg) => applied.push([connId, msg]))
    batcher.push("alice", patch("c1"))
    batcher.push("alice", patch("c2"))
    batcher.push("alice", patch("c3"))
    expect(applied.map(([, m]) => m.viewingCell)).toEqual(["c1"])
    vi.advanceTimersByTime(PRESENCE_TIER2_TICK_MS - 1)
    expect(applied).toHaveLength(1)
    vi.advanceTimersByTime(1)
    // "c2" was superseded inside the tick and is never applied.
    expect(applied.map(([, m]) => m.viewingCell)).toEqual(["c1", "c3"])
    // A quiet tick closes the window; the next update is immediate again.
    vi.advanceTimersByTime(PRESENCE_TIER2_TICK_MS)
    batcher.push("alice", patch("c4"))
    expect(applied.map(([, m]) => m.viewingCell)).toEqual(["c1", "c3", "c4"])
  })

  it("bounds a flooding connection to one apply per tick", () => {
    let applies = 0
    const batcher = new PresenceTier2Batcher(() => {
      applies++
    })
    // 100 frames/s for a second: what the issue's "script a client sending
    // presence at 100/s" check does.
    for (let i = 0; i < 100; i++) {
      batcher.push("alice", patch(`c${i}`))
      vi.advanceTimersByTime(10)
    }
    expect(applies).toBeLessThanOrEqual(1 + Math.ceil(1_000 / PRESENCE_TIER2_TICK_MS))
  })

  it("coalesces by merging patches, so a key another frame never repeats survives", () => {
    const applied: ClientPresenceUpdate[] = []
    const batcher = new PresenceTier2Batcher((_connId, msg) => applied.push(msg))
    batcher.push("alice", { t: "presence.update", currentFileId: "f1" })
    // These three arrive inside the tick. Only `selection` repeats; dropping
    // the frames outright would strand the peer in file f1 and in cell c1.
    batcher.push("alice", { t: "presence.update", currentFileId: "f2" })
    batcher.push("alice", { t: "presence.update", viewingCell: "c1" })
    batcher.push("alice", { t: "presence.update", viewingCell: "c2" })
    vi.advanceTimersByTime(PRESENCE_TIER2_TICK_MS)
    expect(applied).toEqual([
      { t: "presence.update", currentFileId: "f1" },
      { t: "presence.update", currentFileId: "f2", viewingCell: "c2" },
    ])
  })

  it("keeps a null (clear-this-field) patch through a merge", () => {
    const applied: ClientPresenceUpdate[] = []
    const batcher = new PresenceTier2Batcher((_connId, msg) => applied.push(msg))
    batcher.push("alice", { t: "presence.update", viewingCell: "c1" })
    batcher.push("alice", { t: "presence.update", focusedCell: null, selection: null })
    batcher.push("alice", { t: "presence.update", currentFileId: "f9" })
    vi.advanceTimersByTime(PRESENCE_TIER2_TICK_MS)
    expect(applied[1]).toEqual({
      t: "presence.update",
      focusedCell: null,
      selection: null,
      currentFileId: "f9",
    })
  })

  it("batches per connection, not globally", () => {
    const applied: string[] = []
    const batcher = new PresenceTier2Batcher((connId) => applied.push(connId))
    batcher.push("alice", patch("c1"))
    batcher.push("bob", patch("c1"))
    expect(applied).toEqual(["alice", "bob"])
  })

  it("clear() drops the held patch on disconnect", () => {
    const applied: ClientPresenceUpdate[] = []
    const batcher = new PresenceTier2Batcher((_connId, msg) => applied.push(msg))
    batcher.push("alice", patch("c1"))
    batcher.push("alice", patch("c2"))
    batcher.clear("alice")
    vi.advanceTimersByTime(PRESENCE_TIER2_TICK_MS * 2)
    expect(applied.map((m) => m.viewingCell)).toEqual(["c1"])
  })
})

describe("mergePresenceUpdate (AQU-1831)", () => {
  it("returns the later patch when there is nothing to fold onto", () => {
    const next: ClientPresenceUpdate = { t: "presence.update", viewingCell: "c1" }
    expect(mergePresenceUpdate(null, next)).toBe(next)
  })

  it("lets the later patch win per key and keeps the keys it omits", () => {
    expect(
      mergePresenceUpdate(
        { t: "presence.update", currentFileId: "f1", viewingCell: "c1" },
        { t: "presence.update", viewingCell: "c2" },
      ),
    ).toEqual({ t: "presence.update", currentFileId: "f1", viewingCell: "c2" })
  })
})

describe("PresenceFloodGuard (AQU-1831 — inbound token bucket)", () => {
  it("passes a burst, then refuses once the bucket is empty", () => {
    const guard = new PresenceFloodGuard(5, 10)
    for (let i = 0; i < 5; i++) expect(guard.allow("alice", 1_000)).toBe(true)
    expect(guard.allow("alice", 1_000)).toBe(false)
  })

  it("refills over time at the configured rate", () => {
    const guard = new PresenceFloodGuard(5, 10)
    for (let i = 0; i < 5; i++) guard.allow("alice", 1_000)
    expect(guard.allow("alice", 1_050)).toBe(false) // 0.5 tokens back
    expect(guard.allow("alice", 1_100)).toBe(true) // 1 token back
  })

  it("never refills past the burst size", () => {
    const guard = new PresenceFloodGuard(5, 10)
    guard.allow("alice", 0)
    // An hour idle, then a burst: 5 through, the 6th refused.
    for (let i = 0; i < 5; i++) expect(guard.allow("alice", 3_600_000)).toBe(true)
    expect(guard.allow("alice", 3_600_000)).toBe(false)
  })

  it("leaves a client publishing at the workspace's own rate alone", () => {
    const guard = new PresenceFloodGuard()
    // The editor's publishers together top out near 10/s (caret ~120ms is the
    // fastest, and the tier-2 tick absorbs bursts above that).
    let now = 0
    for (let i = 0; i < 600; i++) {
      expect(guard.allow("alice", now)).toBe(true)
      now += 100
    }
  })

  it("throttles a 100/s flooder down to the refill rate", () => {
    const guard = new PresenceFloodGuard()
    let allowed = 0
    let now = 0
    for (let i = 0; i < 1_000; i++) {
      if (guard.allow("alice", now)) allowed++
      now += 10
    }
    // ~10s of frames: at most the burst plus 10s of refill, not all 1,000.
    const ceiling = PRESENCE_FLOOD_BURST + 10 * PRESENCE_FLOOD_REFILL_PER_SEC
    expect(allowed).toBeLessThanOrEqual(ceiling)
    expect(allowed).toBeGreaterThan(ceiling - PRESENCE_FLOOD_REFILL_PER_SEC)
    // The point of the bucket: three quarters of the flood never landed.
    expect(allowed).toBeLessThan(250)
  })

  it("budgets per connection, so one flooder does not throttle its peers", () => {
    const guard = new PresenceFloodGuard(2, 1)
    expect(guard.allow("alice", 0)).toBe(true)
    expect(guard.allow("alice", 0)).toBe(true)
    expect(guard.allow("alice", 0)).toBe(false)
    expect(guard.allow("bob", 0)).toBe(true)
  })

  it("clear() forgets a connection's bucket on disconnect", () => {
    const guard = new PresenceFloodGuard(1, 1)
    expect(guard.allow("alice", 0)).toBe(true)
    expect(guard.allow("alice", 0)).toBe(false)
    guard.clear("alice")
    expect(guard.allow("alice", 0)).toBe(true)
  })
})

describe("boundPresenceDraftText (AQU-1831 — bounded draft payload)", () => {
  it("passes a draft that already fits through untouched", () => {
    const text = "x".repeat(PROJECT_DO_PRESENCE_DRAFT_WIRE_MAX)
    expect(boundPresenceDraftText(text)).toBe(text)
  })

  it("clips a longer draft to the cap, ellipsis included", () => {
    const bounded = boundPresenceDraftText("x".repeat(PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH))
    expect(bounded).toHaveLength(PROJECT_DO_PRESENCE_DRAFT_WIRE_MAX)
    expect(bounded.endsWith("\u2026")).toBe(true)
    expect(bounded.slice(0, 10)).toBe("xxxxxxxxxx")
  })

  it("does not cut a surrogate pair in half", () => {
    // An emoji straddling the cut: the pair is dropped whole rather than
    // leaving a lone high surrogate behind.
    const text = "x".repeat(PROJECT_DO_PRESENCE_DRAFT_WIRE_MAX - 2) + "\u{1f600}" + "tail"
    const bounded = boundPresenceDraftText(text)
    expect(bounded).toHaveLength(PROJECT_DO_PRESENCE_DRAFT_WIRE_MAX - 1)
    expect(bounded.endsWith("\u2026")).toBe(true)
    expect(Array.from(bounded).every((ch) => ch === "x" || ch === "\u2026")).toBe(true)
  })
})

describe("applyPresenceUpdate draft frames (AQU-1831)", () => {
  /** A presence row already holding the lease on cell-1. */
  const holdingLease = (draftText?: string): Map<string, PresenceState> =>
    new Map([
      [
        "alice",
        {
          connId: "alice",
          userId: "alice",
          focusedCell: "cell-1",
          ts: 1,
          selection: { side: "target" as const, anchor: 0, head: 0, ...(draftText !== undefined ? { draftText } : {}) },
        },
      ],
    ])

  const draftFrames = (emit: ProjectDoServerMessage[]): ServerPresenceDraft[] =>
    emit.filter((m): m is ServerPresenceDraft => m.t === "presence.draft")

  it("sends a short draft verbatim", () => {
    const { emit } = applyPresenceUpdate(
      holdingLease(),
      who("alice"),
      { t: "presence.update", selection: { side: "target", anchor: 1, head: 1, draftText: "hola" } },
      2_000,
    )
    expect(draftFrames(emit).map((f) => f.draftText)).toEqual(["hola"])
  })

  it("never puts more than the wire cap on the socket, even for a 16 KB draft", () => {
    const { emit, presence } = applyPresenceUpdate(
      holdingLease(),
      who("alice"),
      {
        t: "presence.update",
        selection: {
          side: "target",
          anchor: 1,
          head: 1,
          draftText: "y".repeat(PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH),
        },
      },
      2_000,
    )
    const frames = draftFrames(emit)
    expect(frames).toHaveLength(1)
    expect(frames[0].draftText).toHaveLength(PROJECT_DO_PRESENCE_DRAFT_WIRE_MAX)
    // The author's own row keeps the whole draft — only the wire is bounded.
    expect(presence.get("alice")?.selection?.draftText).toHaveLength(
      PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH,
    )
  })

  it("stops emitting once edits are past the cap and the visible head is unchanged", () => {
    const head = "z".repeat(PROJECT_DO_MAX_PRESENCE_DRAFT_LENGTH - 1)
    const { emit } = applyPresenceUpdate(
      holdingLease(head),
      who("alice"),
      {
        t: "presence.update",
        selection: { side: "target", anchor: 1, head: 1, draftText: `${head}z` },
      },
      2_000,
    )
    // The row still changed (the caret moved), so a diff goes out — but the
    // bounded draft is byte-identical, so no 2 KB draft frame rides along.
    expect(emit.some((m) => m.t === "presence.diff")).toBe(true)
    expect(draftFrames(emit)).toEqual([])
  })
})

describe("presenceFrameOwnerConnId (AQU-1162 — no self-echo)", () => {
  it("names the connection a presence.diff describes", () => {
    const { emit } = applyPresenceUpdate(
      emptyPresence(),
      who("alice"),
      { t: "presence.update", viewingCell: "c1" },
      1_000,
    )
    expect(emit).toHaveLength(1)
    expect(presenceFrameOwnerConnId(emit[0])).toBe("alice")
  })

  it("names the connection a presence.draft describes", () => {
    const frame: ServerPresenceDraft = {
      t: "presence.draft",
      userId: "alice",
      connId: "alice-tab-2",
      cellId: "c1",
      draftText: "hola",
      ts: 7,
    }
    // Keyed by connId, not userId: a second tab is a separate peer and still
    // needs the other tab's drafts.
    expect(presenceFrameOwnerConnId(frame)).toBe("alice-tab-2")
  })

  it("leaves every non-presence frame addressed to everyone", () => {
    const frames: ProjectDoServerMessage[] = [
      { t: "presence.left", userId: "alice", connId: "alice" },
      { t: "lock.claimed", cellId: "c1", by: { userId: "alice", ts: 1 } },
      { t: "lock.released", cellId: "c1", by: { userId: "alice", ts: 1 } },
      { t: "presence", users: [] },
    ]
    for (const f of frames) expect(presenceFrameOwnerConnId(f)).toBeUndefined()
  })

  it("excludes only the originating socket when the DO fans a frame out", () => {
    // Mirrors ProjectSync.broadcast(): one roster, one sender, everyone else
    // receives. A user's own presence tells them nothing — every client
    // consumer filters self rows out again — so the echo is pure cost.
    const roster = ["alice", "alice-tab-2", "bob"]
    const fanOut = (msg: ProjectDoServerMessage): string[] => {
      const except = presenceFrameOwnerConnId(msg)
      return roster.filter((connId) => connId !== except)
    }
    const { emit } = applyPresenceUpdate(
      emptyPresence(),
      who("alice"),
      { t: "presence.update", viewingCell: "c1" },
      1_000,
    )
    expect(fanOut(emit[0])).toEqual(["alice-tab-2", "bob"])
    // A lock frame still reaches the claimer: it acts on its own grant.
    expect(fanOut({ t: "lock.claimed", cellId: "c1", by: { userId: "alice", ts: 1 } })).toEqual(
      roster,
    )
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

  it("presence.draft carries connId, so two tabs are two separate drafts", () => {
    const a = applyFocusClaim(emptyLocks(), emptyPresence(), tabA, { t: "focus.claim", cellId: "c" }, 1)
    const b = applyFocusClaim(a.locks, a.presence, tabB, { t: "focus.claim", cellId: "c" }, 2)
    const ua = applyPresenceUpdate(b.presence, tabA, { t: "presence.update", selection: { side: "target", anchor: 0, head: 0, draftText: "a" } }, 3)
    const ub = applyPresenceUpdate(ua.presence, tabB, { t: "presence.update", selection: { side: "target", anchor: 0, head: 0, draftText: "b" } }, 4)
    const drafts = [...ua.emit, ...ub.emit].filter(
      (m): m is ServerPresenceDraft => m.t === "presence.draft",
    )
    // AQU-1831 batches by connId (see PresenceTier2Batcher), so the two tabs
    // of one user each keep their own draft rather than shadowing each other.
    expect(drafts.map((f) => [f.connId, f.draftText])).toEqual([["tab-a", "a"], ["tab-b", "b"]])
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

describe("sweepOrphanedPresence (AQU-1374)", () => {
  /** One person, one tab, reconnecting under a fresh connId each time. */
  const sixSilentReconnects = () =>
    new Map<string, PresenceState>(
      ["conn-1", "conn-2", "conn-3", "conn-4", "conn-5", "conn-6"].map((connId) => [
        connId,
        { connId, userId: "fatimah", currentFileId: "file-1", viewingCell: "cell-1", ts: 1 },
      ]),
    )

  it("collapses a user's abandoned rows down to the one live socket", () => {
    const r = sweepOrphanedPresence(sixSilentReconnects(), new Set(["conn-6"]))
    expect([...r.presence.keys()]).toEqual(["conn-6"])
    expect(r.emit).toEqual([
      { t: "presence.left", userId: "fatimah", connId: "conn-1" },
      { t: "presence.left", userId: "fatimah", connId: "conn-2" },
      { t: "presence.left", userId: "fatimah", connId: "conn-3" },
      { t: "presence.left", userId: "fatimah", connId: "conn-4" },
      { t: "presence.left", userId: "fatimah", connId: "conn-5" },
    ])
  })

  it("keeps every row that still has a live socket, idle or not", () => {
    // The client publishes presence on change only, so a stale `ts` must never
    // be grounds for eviction here — liveness of a still-connected socket is
    // the heartbeat sweep's business (selectStaleConnections, AQU-1791).
    const presence = new Map<string, PresenceState>([
      ["tab-a", { connId: "tab-a", userId: "alice", ts: 1 }],
      ["tab-b", { connId: "tab-b", userId: "alice", ts: 1 }],
      ["bob-1", { connId: "bob-1", userId: "bob", focusedCell: "cell-1", ts: 1 }],
    ])
    const r = sweepOrphanedPresence(presence, new Set(["tab-a", "tab-b", "bob-1"]))
    expect(r.emit).toEqual([])
    expect(r.presence).toEqual(presence)
  })

  it("drops one tab's orphan without disturbing the user's other live tab", () => {
    const presence = new Map<string, PresenceState>([
      ["tab-a", { connId: "tab-a", userId: "alice", viewingCell: "cell-1", ts: 1 }],
      ["tab-b", { connId: "tab-b", userId: "alice", viewingCell: "cell-2", ts: 1 }],
    ])
    const r = sweepOrphanedPresence(presence, new Set(["tab-b"]))
    expect([...r.presence.keys()]).toEqual(["tab-b"])
    expect(r.emit).toEqual([{ t: "presence.left", userId: "alice", connId: "tab-a" }])
  })

  it("does not mutate the map it was given", () => {
    const presence = sixSilentReconnects()
    sweepOrphanedPresence(presence, new Set(["conn-6"]))
    expect(presence.size).toBe(6)
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

  describe("same-tab takeover (AQU-1791)", () => {
    const owned = new Map<string, { connId: string; userId: string }>([
      ["ws1", { connId: "tab-of-fatimah", userId: "fatimah" }],
    ])

    it("hands a returning tab back the connId its own dead socket still holds", () => {
      // The dirty-disconnect case: the old socket is still in the map because
      // no close frame ever arrived. Minting a fresh id here is what left the
      // ghost row behind.
      expect(resolveConnId("tab-of-fatimah", owned, "fatimah")).toBe("tab-of-fatimah")
    })

    it("refuses another user's connId, so presence cannot be evicted by guessing", () => {
      expect(resolveConnId("tab-of-fatimah", owned, "mallory")).toMatch(/^[0-9a-f-]{36}$/)
    })

    it("still refuses a collision when the caller passes no identity", () => {
      expect(resolveConnId("tab-of-fatimah", owned)).toMatch(/^[0-9a-f-]{36}$/)
    })
  })
})

describe("selectStaleConnections (AQU-1791)", () => {
  const conn = (
    connId: string,
    overrides: Partial<{ userId: string; lastSeenAt: number; heartbeatSeen: boolean }> = {},
  ) => ({
    connId,
    userId: overrides.userId ?? "fatimah",
    lastSeenAt: overrides.lastSeenAt ?? 0,
    heartbeatSeen: overrides.heartbeatSeen ?? true,
  })

  const now = 10 * 60 * 1000

  it("retires a heartbeating socket that went silent past the TTL", () => {
    // The half-open case AQU-1374's orphan sweep cannot see: the socket is
    // still connected as far as the DO knows, so its presence row looks live.
    const stale = selectStaleConnections(
      [conn("ghost", { lastSeenAt: now - PRESENCE_HEARTBEAT_TTL_MS - 1 })],
      now,
    )
    expect(stale.map((c) => c.connId)).toEqual(["ghost"])
  })

  it("keeps a socket whose last frame is still inside the TTL", () => {
    expect(
      selectStaleConnections([conn("live", { lastSeenAt: now - PRESENCE_HEARTBEAT_TTL_MS })], now),
    ).toEqual([])
  })

  it("never retires a client that has not proven it heartbeats", () => {
    // A client predating the `ping` heartbeat is silent by design; evicting it
    // would drop a live user from the roster every TTL.
    expect(
      selectStaleConnections([conn("old-client", { lastSeenAt: 0, heartbeatSeen: false })], now),
    ).toEqual([])
  })

  it("retires only the dead socket of a user whose other tab is still alive", () => {
    const stale = selectStaleConnections(
      [
        conn("tab-a", { lastSeenAt: now - PRESENCE_HEARTBEAT_TTL_MS - 1 }),
        conn("tab-b", { lastSeenAt: now - 1_000 }),
      ],
      now,
    )
    expect(stale.map((c) => c.connId)).toEqual(["tab-a"])
  })
})
