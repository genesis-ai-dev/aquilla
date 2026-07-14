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
})
