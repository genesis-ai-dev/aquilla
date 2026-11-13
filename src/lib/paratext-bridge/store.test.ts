import { beforeEach, describe, it, expect } from "vitest"
import { openDB } from "idb"
import { IDBFactory } from "fake-indexeddb"
import { bridgeStore, resetBridgeStoreForTests } from "./store"
import { deriveUnits } from "./units"
import { bridgeStateId, type BridgeStateId } from "./project"

const GUID = "6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d"
const ID = bridgeStateId(GUID, "/p/TPP1")

describe("bridgeStore", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
  })

  it("keeps pending edits per book and clears them by unit or by book", async () => {
    await bridgeStore.putPendingEdit(ID, "MAT", { unitId: "MAT 1:1", text: "a", baseRawHash: "h1" })
    await bridgeStore.putPendingEdit(ID, "MAT", { unitId: "MAT 1:2", text: "b", baseRawHash: "h2" })
    await bridgeStore.putPendingEdit(ID, "MRK", { unitId: "MRK 1:1", text: "c", baseRawHash: "h3" })
    expect((await bridgeStore.pendingEdits(ID, "MAT")).map((e) => e.unitId).sort()).toEqual(["MAT 1:1", "MAT 1:2"])
    // Re-putting the same unit replaces, never duplicates.
    await bridgeStore.putPendingEdit(ID, "MAT", { unitId: "MAT 1:1", text: "a2", baseRawHash: "h1" })
    expect((await bridgeStore.pendingEdits(ID, "MAT")).find((e) => e.unitId === "MAT 1:1")?.text).toBe("a2")
    await bridgeStore.deletePendingEdits(ID, ["MAT 1:1"])
    expect((await bridgeStore.pendingEdits(ID, "MAT")).map((e) => e.unitId)).toEqual(["MAT 1:2"])
    await bridgeStore.clearPendingEdits(ID, "MAT")
    expect(await bridgeStore.pendingEdits(ID, "MAT")).toEqual([])
    expect((await bridgeStore.pendingEdits(ID, "MRK")).length).toBe(1)
  })

  it("records writes, own blobs, last-seen units and holds", async () => {
    const units = await deriveUnits(new TextEncoder().encode("\\id MAT\n\\c 1\n\\v 1 One.\n"))
    await bridgeStore.recordWrites(ID, "MAT", [{ unitId: "MAT 1:1", previousRawHash: "p", newRawHash: "n" }])
    expect(await bridgeStore.writeLog(ID, "MAT")).toEqual([{ unitId: "MAT 1:1", previousRawHash: "p", newRawHash: "n" }])
    await bridgeStore.recordOwnBlob(ID, "MAT", units.blobHash)
    expect((await bridgeStore.ownBlobHashes(ID, "MAT")).has(units.blobHash)).toBe(true)
    expect(await bridgeStore.lastSeen(ID, "MAT")).toBeNull()
    await bridgeStore.setLastSeen(ID, "MAT", units)
    expect((await bridgeStore.lastSeen(ID, "MAT"))?.blobHash).toBe(units.blobHash)
    expect(await bridgeStore.hold(ID, "MAT")).toBe(false)
    await bridgeStore.setHold(ID, "MAT", true)
    expect(await bridgeStore.hold(ID, "MAT")).toBe(true)
    await bridgeStore.setHold(ID, "MAT", false)
    expect(await bridgeStore.hold(ID, "MAT")).toBe(false)
  })
})

describe("bridgeStore links", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
  })

  it("finds a mirror link by Paratext folder and by Aquilla project id", async () => {
    const link = {
      projectGuid: GUID, projectPath: "/p/TPP1", projectId: "proj-1", targetLang: "",
      books: { MAT: { fileId: "f-mat", fileName: "41MATTPP1.SFM" } }, createdAt: 1,
    }
    expect(await bridgeStore.link(ID)).toBeNull()
    await bridgeStore.putLink(link)
    expect(await bridgeStore.link(ID)).toEqual(link)
    expect(await bridgeStore.linkForProject("proj-1")).toEqual(link)
    expect(await bridgeStore.linkForProject("other")).toBeNull()
    // A second import of the same Paratext folder replaces the link: one
    // mirror per folder, so the badge never has two candidates.
    await bridgeStore.putLink({ ...link, projectId: "proj-2" })
    expect((await bridgeStore.link(ID))?.projectId).toBe("proj-2")
    expect(await bridgeStore.linkForProject("proj-1")).toBeNull()
    await bridgeStore.deleteLink(ID)
    expect(await bridgeStore.link(ID)).toBeNull()
  })
})

// One project can sit in two folders on a computer: Paratext 10 and Paratext
// Lite each keep their own copy. The copies are different files, so what
// Aquilla remembers about one (an unwritten edit, a hold, "this is mirrored")
// must not show up for the other.
describe("bridgeStore with one project in two folders", () => {
  const P10 = bridgeStateId(GUID, "/home/.paratext-10-studio/projects/Paratext 9 Projects/MAO")
  const LITE = bridgeStateId(GUID, "/home/Library/Application Support/paratextlite/Paratext8Projects/MAO")

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
  })

  it("keeps each folder's edits, last-seen units, write log and hold apart", async () => {
    const units = await deriveUnits(new TextEncoder().encode("\\id MAT\n\\c 1\n\\v 1 a\n"))
    await bridgeStore.putPendingEdit(P10, "MAT", { unitId: "MAT 1:1", text: "typed in the Paratext 10 copy", baseRawHash: "h" })
    await bridgeStore.setLastSeen(P10, "MAT", units)
    await bridgeStore.recordWrites(P10, "MAT", [{ unitId: "MAT 1:1", previousRawHash: "p", newRawHash: "n" }])
    await bridgeStore.recordOwnBlob(P10, "MAT", units.blobHash)
    await bridgeStore.setHold(P10, "MAT", true)

    expect(await bridgeStore.pendingEdits(LITE, "MAT")).toEqual([])
    expect(await bridgeStore.lastSeen(LITE, "MAT")).toBeNull()
    expect(await bridgeStore.writeLog(LITE, "MAT")).toEqual([])
    expect((await bridgeStore.ownBlobHashes(LITE, "MAT")).size).toBe(0)
    expect(await bridgeStore.hold(LITE, "MAT")).toBe(false)

    // The same verse edited in the other copy is a second edit, not an overwrite.
    await bridgeStore.putPendingEdit(LITE, "MAT", { unitId: "MAT 1:1", text: "typed in the Lite copy", baseRawHash: "h" })
    expect((await bridgeStore.pendingEdits(P10, "MAT"))[0].text).toBe("typed in the Paratext 10 copy")
    await bridgeStore.clearPendingEdits(LITE, "MAT")
    expect(await bridgeStore.pendingEdits(P10, "MAT")).toHaveLength(1)
  })

  it("mirrors each folder into its own Aquilla project", async () => {
    const link = { projectGuid: GUID, targetLang: "", books: {}, createdAt: 1 }
    await bridgeStore.putLink({ ...link, projectPath: "/home/.paratext-10-studio/projects/Paratext 9 Projects/MAO", projectId: "proj-p10" })
    expect(await bridgeStore.link(LITE)).toBeNull()
    await bridgeStore.putLink({ ...link, projectPath: "/home/Library/Application Support/paratextlite/Paratext8Projects/MAO", projectId: "proj-lite" })
    expect((await bridgeStore.link(P10))?.projectId).toBe("proj-p10")
    expect((await bridgeStore.link(LITE))?.projectId).toBe("proj-lite")
  })
})

// Before state was per folder it was keyed by the bare GUID. Those rows are a
// user's unwritten edits and the base their mirror merges against, so they
// must follow the folder they were made for rather than vanish, and must not
// land on a second copy of the project.
describe("bridgeStore state saved under the bare GUID", () => {
  const LEGACY = GUID as BridgeStateId // the key an older version wrote under
  const WINE = "/home/.wine-paratext/drive_c/TPP1"
  const LITE = "/home/Library/Application Support/paratextlite/Paratext8Projects/TPP1"
  const edit = { unitId: "MAT 1:1", text: "unwritten", baseRawHash: "h" }

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
  })

  it("moves with its mirror link to the folder the link names", async () => {
    const units = await deriveUnits(new TextEncoder().encode("\\id MAT\n\\c 1\n\\v 1 a\n"))
    await bridgeStore.setLastSeen(LEGACY, "MAT", units)
    await bridgeStore.setHold(LEGACY, "MAT", true)
    const link = { projectGuid: GUID, projectPath: WINE, projectId: "proj-1", targetLang: "", books: {}, createdAt: 1 }
    const raw = await openDB("aquilla-paratext-bridge")
    await raw.put("links", { ...link, key: `pt:${GUID}` })
    raw.close()
    resetBridgeStoreForTests() // next call is a fresh app start

    expect(await bridgeStore.linkForProject("proj-1")).toEqual(link)
    expect(await bridgeStore.link(bridgeStateId(GUID, WINE))).toEqual(link)
    expect((await bridgeStore.lastSeen(bridgeStateId(GUID, WINE), "MAT"))?.blobHash).toBe(units.blobHash)
    expect(await bridgeStore.hold(bridgeStateId(GUID, WINE), "MAT")).toBe(true)
    // The Lite copy of the same project is not mirrored and has no state,
    // even when it is the first one opened.
    await bridgeStore.adoptLegacyState(GUID, bridgeStateId(GUID, LITE))
    expect(await bridgeStore.link(bridgeStateId(GUID, LITE))).toBeNull()
    expect(await bridgeStore.lastSeen(bridgeStateId(GUID, LITE), "MAT")).toBeNull()
    expect(await bridgeStore.hold(bridgeStateId(GUID, LITE), "MAT")).toBe(false)
  })

  it("goes to the first folder opened when no link names one, and only to that one", async () => {
    await bridgeStore.putPendingEdit(LEGACY, "MAT", edit)
    await bridgeStore.putPendingEdit(LEGACY, "MRK", { ...edit, unitId: "MRK 1:1" })
    await bridgeStore.adoptLegacyState(GUID, bridgeStateId(GUID, WINE))
    await bridgeStore.adoptLegacyState(GUID, bridgeStateId(GUID, LITE))
    expect(await bridgeStore.pendingEdits(bridgeStateId(GUID, WINE), "MAT")).toEqual([edit])
    expect(await bridgeStore.pendingEdits(bridgeStateId(GUID, WINE), "MRK")).toHaveLength(1)
    expect(await bridgeStore.pendingEdits(bridgeStateId(GUID, LITE), "MAT")).toEqual([])
    // Adopted edits stay editable under the folder's own keys.
    await bridgeStore.deletePendingEdits(bridgeStateId(GUID, WINE), ["MAT 1:1"])
    expect(await bridgeStore.pendingEdits(bridgeStateId(GUID, WINE), "MAT")).toEqual([])
  })
})
