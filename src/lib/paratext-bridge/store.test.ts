import { beforeEach, describe, it, expect } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import { bridgeStore, resetBridgeStoreForTests } from "./store"
import { deriveUnits } from "./units"

const GUID = "6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d"

describe("bridgeStore", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
  })

  it("keeps pending edits per book and clears them by unit or by book", async () => {
    await bridgeStore.putPendingEdit(GUID, "MAT", { unitId: "MAT 1:1", text: "a", baseRawHash: "h1" })
    await bridgeStore.putPendingEdit(GUID, "MAT", { unitId: "MAT 1:2", text: "b", baseRawHash: "h2" })
    await bridgeStore.putPendingEdit(GUID, "MRK", { unitId: "MRK 1:1", text: "c", baseRawHash: "h3" })
    expect((await bridgeStore.pendingEdits(GUID, "MAT")).map((e) => e.unitId).sort()).toEqual(["MAT 1:1", "MAT 1:2"])
    // Re-putting the same unit replaces, never duplicates.
    await bridgeStore.putPendingEdit(GUID, "MAT", { unitId: "MAT 1:1", text: "a2", baseRawHash: "h1" })
    expect((await bridgeStore.pendingEdits(GUID, "MAT")).find((e) => e.unitId === "MAT 1:1")?.text).toBe("a2")
    await bridgeStore.deletePendingEdits(GUID, ["MAT 1:1"])
    expect((await bridgeStore.pendingEdits(GUID, "MAT")).map((e) => e.unitId)).toEqual(["MAT 1:2"])
    await bridgeStore.clearPendingEdits(GUID, "MAT")
    expect(await bridgeStore.pendingEdits(GUID, "MAT")).toEqual([])
    expect((await bridgeStore.pendingEdits(GUID, "MRK")).length).toBe(1)
  })

  it("records writes, own blobs, last-seen units and holds", async () => {
    const units = await deriveUnits(new TextEncoder().encode("\\id MAT\n\\c 1\n\\v 1 One.\n"))
    await bridgeStore.recordWrites(GUID, "MAT", [{ unitId: "MAT 1:1", previousRawHash: "p", newRawHash: "n" }])
    expect(await bridgeStore.writeLog(GUID, "MAT")).toEqual([{ unitId: "MAT 1:1", previousRawHash: "p", newRawHash: "n" }])
    await bridgeStore.recordOwnBlob(GUID, "MAT", units.blobHash)
    expect((await bridgeStore.ownBlobHashes(GUID, "MAT")).has(units.blobHash)).toBe(true)
    expect(await bridgeStore.lastSeen(GUID, "MAT")).toBeNull()
    await bridgeStore.setLastSeen(GUID, "MAT", units)
    expect((await bridgeStore.lastSeen(GUID, "MAT"))?.blobHash).toBe(units.blobHash)
    expect(await bridgeStore.hold(GUID, "MAT")).toBe(false)
    await bridgeStore.setHold(GUID, "MAT", true)
    expect(await bridgeStore.hold(GUID, "MAT")).toBe(true)
    await bridgeStore.setHold(GUID, "MAT", false)
    expect(await bridgeStore.hold(GUID, "MAT")).toBe(false)
  })
})

describe("bridgeStore links", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
  })

  it("finds a mirror link by Paratext GUID and by Aquilla project id", async () => {
    const link = {
      projectGuid: GUID, projectPath: "/p/TPP1", projectId: "proj-1", targetLang: "",
      books: { MAT: { fileId: "f-mat", fileName: "41MATTPP1.SFM" } }, createdAt: 1,
    }
    expect(await bridgeStore.link(GUID)).toBeNull()
    await bridgeStore.putLink(link)
    expect(await bridgeStore.link(GUID)).toEqual(link)
    expect(await bridgeStore.linkForProject("proj-1")).toEqual(link)
    expect(await bridgeStore.linkForProject("other")).toBeNull()
    // A second import of the same Paratext project replaces the link: one
    // mirror per GUID, so the badge never has two candidates.
    await bridgeStore.putLink({ ...link, projectId: "proj-2" })
    expect((await bridgeStore.link(GUID))?.projectId).toBe("proj-2")
    expect(await bridgeStore.linkForProject("proj-1")).toBeNull()
    await bridgeStore.deleteLink(GUID)
    expect(await bridgeStore.link(GUID)).toBeNull()
  })
})
