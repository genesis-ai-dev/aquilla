import { describe, expect, it, vi } from "vitest"
import { createProjectPresenceStore } from "./presence-store"

describe("ProjectPresenceStore", () => {
  it("notifies only affected cell subscribers when cursor selection changes", () => {
    const store = createProjectPresenceStore("me")
    const cell1 = vi.fn()
    const cell2 = vi.fn()
    const roster = vi.fn()
    store.subscribeCell("cell-1", cell1)
    store.subscribeCell("cell-2", cell2)
    store.subscribeRoster(roster)

    store.applyPresenceFrame([
      {
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 0, head: 0, draftText: "H" },
        ts: 1,
      },
    ])

    expect(roster).toHaveBeenCalledTimes(1)
    expect(cell1).toHaveBeenCalledTimes(1)
    expect(cell2).not.toHaveBeenCalled()
    expect(store.getCellPresence("cell-1")[0]?.selection).toEqual({
      side: "target",
      anchor: 0,
      head: 0,
      draftText: "H",
    })

    store.applyPresenceFrame([
      {
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 2, head: 4, draftText: "Hello" },
        ts: 2,
      },
    ])

    expect(roster).toHaveBeenCalledTimes(1)
    expect(cell1).toHaveBeenCalledTimes(2)
    expect(cell2).not.toHaveBeenCalled()
    expect(store.getCellPresence("cell-1")[0]?.selection).toEqual({
      side: "target",
      anchor: 2,
      head: 4,
      draftText: "Hello",
    })
  })

  it("moves cell subscriptions when a peer changes focused cells", () => {
    const store = createProjectPresenceStore("me")
    const cell1 = vi.fn()
    const cell2 = vi.fn()
    store.subscribeCell("cell-1", cell1)
    store.subscribeCell("cell-2", cell2)

    store.applyPresenceFrame([
      { userId: "alice", currentFileId: "file-1", focusedCell: "cell-1", ts: 1 },
    ])
    store.applyPresenceFrame([
      { userId: "alice", currentFileId: "file-1", focusedCell: "cell-2", ts: 2 },
    ])

    expect(cell1).toHaveBeenCalledTimes(2)
    expect(cell2).toHaveBeenCalledTimes(1)
    expect(store.getCellPresence("cell-1")).toHaveLength(0)
    expect(store.getCellPresence("cell-2")[0]?.username).toBe("alice")
  })

  // AQU-559 rule 1: never surface the current user's own presence — not in the
  // roster and not on any cell. "you don't need to see yourself looking at it."
  it("excludes the current user from roster and cell presence", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceFrame([
      { userId: "me", currentFileId: "file-1", focusedCell: "cell-1", ts: 1 },
      { userId: "alice", currentFileId: "file-1", focusedCell: "cell-1", ts: 1 },
    ])

    expect(store.getPeers().map((p) => p.username)).toEqual(["alice"])
    const cell = store.getCellPresence("cell-1")
    expect(cell.map((p) => p.username)).toEqual(["alice"])
  })

  // AQU-559 rule 1, legacy-token path: a token minted without a `username`
  // claim makes the sync DO stamp the connection as `user:<numericId>`, so the
  // user's own frame arrives under that id instead of their username. Once the
  // roster resolves the numeric id, addSelfId must re-filter it out.
  it("excludes the current user's own `user:<id>` fallback identity", () => {
    const store = createProjectPresenceStore("me")
    const roster = vi.fn()
    store.subscribeRoster(roster)
    const cell = vi.fn()
    store.subscribeCell("cell-1", cell)

    // Own frame stamped with the numeric fallback form, before the id is known.
    store.applyPresenceFrame([
      { userId: "user:42", currentFileId: "file-1", focusedCell: "cell-1", ts: 1 },
    ])
    expect(store.getPeers().map((p) => p.username)).toEqual(["user:42"])
    expect(store.getCellPresence("cell-1")).toHaveLength(1)

    // Roster resolves the caller's numeric id → register it as self.
    store.addSelfId("user:42")
    expect(store.getPeers()).toHaveLength(0)
    expect(store.getCellPresence("cell-1")).toHaveLength(0)
    // Subscribers were poked so the UI drops the stale self indicator live.
    expect(roster).toHaveBeenCalled()
    expect(cell).toHaveBeenCalled()
  })

  // AQU-559 rule 2: a peer merely *viewing* the file (currentFileId set, no
  // focusedCell) belongs in the roster but must not crowd any cell's presence.
  // Only an actively-focused peer shows on the cell.
  it("shows a viewing-only peer in the roster but on no cell", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceFrame([
      { userId: "alice", currentFileId: "file-1", ts: 1 },
    ])

    expect(store.getPeers().map((p) => p.username)).toEqual(["alice"])
    expect(store.getPeers()[0]?.isEditing).toBe(false)
    expect(store.getCellPresence("cell-1")).toHaveLength(0)

    // Alice now focuses a cell → she appears there.
    store.applyPresenceFrame([
      { userId: "alice", currentFileId: "file-1", focusedCell: "cell-1", ts: 2 },
    ])
    expect(store.getCellPresence("cell-1").map((p) => p.username)).toEqual(["alice"])
  })

  // WS-D: presence.diff carries one user. Other peers' cells must not be poked
  // and the roster only fires when a roster-visible field changed.
  it("applies a diff to one peer without touching the others", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceFrame([
      { userId: "alice", currentFileId: "file-1", focusedCell: "cell-1", ts: 1 },
      { userId: "bob", currentFileId: "file-1", focusedCell: "cell-2", ts: 1 },
    ])
    const cell1 = vi.fn()
    const cell2 = vi.fn()
    const roster = vi.fn()
    store.subscribeCell("cell-1", cell1)
    store.subscribeCell("cell-2", cell2)
    store.subscribeRoster(roster)

    // Selection-only change: cell listeners for alice's cell, roster untouched.
    store.applyPresenceDiff({
      userId: "alice",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: 1, head: 1 },
      ts: 2,
    })
    expect(roster).not.toHaveBeenCalled()
    expect(cell1).toHaveBeenCalledTimes(1)
    expect(cell2).not.toHaveBeenCalled()

    // Focus move: roster fires once, both cells (left + entered) update.
    store.applyPresenceDiff({ userId: "alice", currentFileId: "file-1", focusedCell: "cell-2", ts: 3 })
    expect(roster).toHaveBeenCalledTimes(1)
    expect(cell1).toHaveBeenCalledTimes(2)
    expect(cell2).toHaveBeenCalledTimes(1)
    expect(store.getCellPresence("cell-1")).toHaveLength(0)
    expect(store.getCellPresence("cell-2").map((p) => p.username).sort()).toEqual(["alice", "bob"])
    expect(store.getPeers().map((p) => p.username)).toEqual(["alice", "bob"])
  })

  // WS-D: drafts are the hot path (one frame per 150 ms per typing peer). They
  // must reach only the cell being typed in — never the roster — so the
  // workspace root stays out of the keystroke render loop.
  it("routes a draft frame to its cell listeners only", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceFrame([
      {
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 0, head: 0 },
        ts: 1,
      },
    ])
    const cell1 = vi.fn()
    const cell2 = vi.fn()
    const roster = vi.fn()
    store.subscribeCell("cell-1", cell1)
    store.subscribeCell("cell-2", cell2)
    store.subscribeRoster(roster)

    store.applyPresenceDraft("alice", "cell-1", "Hel", 2)
    store.applyPresenceDraft("alice", "cell-1", "Hello", 3)

    expect(roster).not.toHaveBeenCalled()
    expect(cell1).toHaveBeenCalledTimes(2)
    expect(cell2).not.toHaveBeenCalled()
    expect(store.getCellPresence("cell-1")[0]?.selection?.draftText).toBe("Hello")

    // Out-of-order older draft is dropped (latest wins).
    store.applyPresenceDraft("alice", "cell-1", "He", 2)
    expect(store.getCellPresence("cell-1")[0]?.selection?.draftText).toBe("Hello")
    expect(cell1).toHaveBeenCalledTimes(2)

    // A diff without draftText (the wire strips it) keeps the live draft.
    store.applyPresenceDiff({
      userId: "alice",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: 5, head: 5 },
      ts: 4,
    })
    expect(store.getCellPresence("cell-1")[0]?.selection).toEqual({
      side: "target",
      anchor: 5,
      head: 5,
      draftText: "Hello",
    })
  })

  it("removes a departed peer from roster and cell", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceFrame([
      { userId: "alice", currentFileId: "file-1", focusedCell: "cell-1", ts: 1 },
      { userId: "bob", currentFileId: "file-1", ts: 1 },
    ])
    store.applyPresenceDraft("alice", "cell-1", "Hi", 2)
    const cell1 = vi.fn()
    const roster = vi.fn()
    store.subscribeCell("cell-1", cell1)
    store.subscribeRoster(roster)

    store.applyPresenceLeft("alice")
    expect(roster).toHaveBeenCalledTimes(1)
    expect(cell1).toHaveBeenCalledTimes(1)
    expect(store.getPeers().map((p) => p.username)).toEqual(["bob"])
    expect(store.getCellPresence("cell-1")).toHaveLength(0)

    // Unknown user: no-op, nothing fires.
    store.applyPresenceLeft("nobody")
    expect(roster).toHaveBeenCalledTimes(1)
    expect(cell1).toHaveBeenCalledTimes(1)
  })

  // A full snapshot is authoritative: a user it reports with no selection has
  // stopped typing, so any draft we were holding for them is stale.
  it("clears stale drafts on a full snapshot without selection", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceFrame([
      {
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 0, head: 0 },
        ts: 1,
      },
    ])
    store.applyPresenceDraft("alice", "cell-1", "Hello", 2)
    expect(store.getCellPresence("cell-1")[0]?.selection?.draftText).toBe("Hello")

    store.applyPresenceFrame([
      { userId: "alice", currentFileId: "file-1", focusedCell: "cell-1", ts: 3 },
    ])
    expect(store.getCellPresence("cell-1")[0]?.selection).toBeUndefined()

    // Re-focusing with a selection does not resurrect the cleared draft.
    store.applyPresenceDiff({
      userId: "alice",
      currentFileId: "file-1",
      focusedCell: "cell-1",
      selection: { side: "target", anchor: 0, head: 0 },
      ts: 4,
    })
    expect(store.getCellPresence("cell-1")[0]?.selection?.draftText).toBeUndefined()
  })

  it("shows a peer on the row they merely view (no lock) and marks them not editing", () => {
    // A viewer/reviewer, or a contributor whose lease claim was denied, has
    // viewingCell but no focusedCell — the row must still show them.
    const store = createProjectPresenceStore("me")
    const cell = vi.fn()
    store.subscribeCell("cell-3", cell)
    store.applyPresenceDiff({ userId: "bob", currentFileId: "f", viewingCell: "cell-3", ts: 1 })
    expect(cell).toHaveBeenCalledTimes(1)
    expect(store.getCellPresence("cell-3")).toMatchObject([
      { peerId: "bob", viewingCell: "cell-3", isEditing: false },
    ])
    expect(store.getPeers()).toMatchObject([{ peerId: "bob", viewingCell: "cell-3" }])

    // Moving to another row clears the old one and lights the new one.
    store.applyPresenceDiff({ userId: "bob", currentFileId: "f", viewingCell: "cell-4", ts: 2 })
    expect(store.getCellPresence("cell-3")).toEqual([])
    expect(store.getCellPresence("cell-4")).toMatchObject([{ peerId: "bob", isEditing: false }])
  })

  it("lets the lease-held cell win over viewingCell and never lists the peer twice", () => {
    const store = createProjectPresenceStore("me")
    store.applyPresenceDiff({
      userId: "bob", focusedCell: "cell-1", viewingCell: "cell-1", ts: 1,
    })
    expect(store.getCellPresence("cell-1")).toMatchObject([{ peerId: "bob", isEditing: true }])
    expect(store.getCellPresence("cell-1")).toHaveLength(1)
    // Lease swept while the user stays on the row: still visible, no longer editing.
    store.applyPresenceDiff({ userId: "bob", viewingCell: "cell-1", ts: 2 })
    expect(store.getCellPresence("cell-1")).toMatchObject([{ peerId: "bob", isEditing: false }])
  })

  // Presence rows are per CONNECTION. Two tabs — or two people on one shared
  // test account — must both be visible to everyone else, and each must see
  // the other. "Self" is our own socket's connId, never the username.
  describe("per-connection rows for one account", () => {
    const rows = [
      { connId: "tab-a", userId: "me", currentFileId: "file-1", viewingCell: "cell-1", ts: 1 },
      { connId: "tab-b", userId: "me", currentFileId: "file-1", viewingCell: "cell-2", ts: 2 },
      { connId: "alice-1", userId: "alice", currentFileId: "file-1", focusedCell: "cell-1", ts: 3 },
    ]

    it("hides only this socket's row and shows the same account's other connection", () => {
      const store = createProjectPresenceStore("me")
      store.setSelfConnId("tab-a")
      store.applyPresenceFrame(rows)
      expect(store.getPeers().map((p) => [p.peerId, p.username])).toEqual([
        ["alice-1", "alice"],
        ["tab-b", "me"],
      ])
      expect(store.getCellPresence("cell-1").map((p) => p.peerId)).toEqual(["alice-1"])
      expect(store.getCellPresence("cell-2").map((p) => p.peerId)).toEqual(["tab-b"])
    })

    it("re-filters when the connId arrives after the roster", () => {
      const store = createProjectPresenceStore("me")
      const roster = vi.fn()
      store.subscribeRoster(roster)
      store.applyPresenceFrame(rows)
      expect(store.getPeers()).toHaveLength(3)
      store.setSelfConnId("tab-b")
      expect(store.getPeers().map((p) => p.peerId)).toEqual(["alice-1", "tab-a"])
      expect(roster).toHaveBeenCalledTimes(2)
    })

    it("lists both connections of one account to a third party", () => {
      const store = createProjectPresenceStore("carol")
      store.setSelfConnId("carol-1")
      store.applyPresenceFrame(rows)
      expect(store.getPeers().map((p) => p.peerId)).toEqual(["alice-1", "tab-a", "tab-b"])
      // Same account → same colour and name; distinct peer ids keep React keys stable.
      const [, a, b] = store.getPeers()
      expect(a.color).toBe(b.color)
      expect(a.username).toBe(b.username)
    })

    it("a presence.left for one connection leaves the account's other row in place", () => {
      const store = createProjectPresenceStore("carol")
      store.setSelfConnId("carol-1")
      store.applyPresenceFrame(rows)
      store.applyPresenceLeft("tab-a")
      expect(store.getPeers().map((p) => p.peerId)).toEqual(["alice-1", "tab-b"])
      expect(store.getCellPresence("cell-1").map((p) => p.peerId)).toEqual(["alice-1"])
    })

    it("keys drafts by connection so two tabs of one account do not clobber each other", () => {
      const store = createProjectPresenceStore("carol")
      store.setSelfConnId("carol-1")
      store.applyPresenceFrame([
        { connId: "tab-a", userId: "me", focusedCell: "cell-1", selection: { side: "target", anchor: 0, head: 0 }, ts: 1 },
        { connId: "tab-b", userId: "me", focusedCell: "cell-2", selection: { side: "target", anchor: 0, head: 0 }, ts: 2 },
      ])
      store.applyPresenceDraft("tab-a", "cell-1", "one", 3)
      store.applyPresenceDraft("tab-b", "cell-2", "two", 4)
      expect(store.getCellPresence("cell-1")[0]?.selection?.draftText).toBe("one")
      expect(store.getCellPresence("cell-2")[0]?.selection?.draftText).toBe("two")
    })

    it("still hides the synthetic lock-holder row for our own username (locks are per user)", () => {
      // Our own focus.claim echoes as lock.claimed by username; with no other
      // row on the cell that must not surface as a fake peer.
      const store = createProjectPresenceStore("me")
      store.setSelfConnId("tab-a")
      store.applyLockClaimed("cell-9", "me")
      expect(store.getCellPresence("cell-9")).toHaveLength(0)
      store.applyLockClaimed("cell-8", "alice")
      expect(store.getCellPresence("cell-8").map((p) => p.username)).toEqual(["alice"])
    })
  })
})
