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
        selection: { side: "target", anchor: 0, head: 0 },
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
    })

    store.applyPresenceFrame([
      {
        userId: "alice",
        currentFileId: "file-1",
        focusedCell: "cell-1",
        selection: { side: "target", anchor: 2, head: 4 },
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
})
