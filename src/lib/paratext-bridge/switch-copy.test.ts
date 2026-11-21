import { beforeEach, describe, it, expect, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import { bridgeStore, resetBridgeStoreForTests, type MirrorLink } from "./store"
import { bridgeStateId } from "./project"
import { deriveUnits } from "./units"
import type { BridgeProject } from "./use-paratext-discovery"

const hashes = new Map<string, string>()
vi.mock("./tauri", () => ({
  paratextTauri: { hashFile: async (dir: string, file: string) => hashes.get(`${dir}/${file}`) ?? "none" },
}))

const { switchLiveCopy } = await import("./switch-copy")

const GUID = "6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d"
const P9 = "/Users/me/Paratext9Projects/TPP1"
const P10 = "/Users/me/.paratext-10-studio/projects/Paratext 9 Projects/TPP1"
const FROM = bridgeStateId(GUID, P9)
const TO = bridgeStateId(GUID, P10)
const FILE = "41MATTPP1.SFM"

const LINK: MirrorLink = {
  projectGuid: GUID, projectPath: P9, projectId: "proj-1", targetLang: "",
  books: { MAT: { fileId: "f-mat", fileName: FILE } }, createdAt: 1,
}

function copy(path: string, books = [{ code: "MAT", fileName: FILE }]): BridgeProject {
  return {
    path, folderName: "TPP1", guid: GUID, stateId: bridgeStateId(GUID, path),
    settings: { guid: GUID } as BridgeProject["settings"], utf8: true, access: null, books,
  }
}

async function seen(text: string) {
  return deriveUnits(new TextEncoder().encode(text))
}

describe("switchLiveCopy", () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
    hashes.clear()
    await bridgeStore.putLink(LINK)
  })

  // The happy path: identical files, so the old base is valid for the new copy
  // and Aquilla's unwritten edits will land in the new copy.
  it("moves the link and the base to the new copy when the files are identical", async () => {
    const units = await seen("\\id MAT\n\\c 1\n\\v 1 One.\n")
    await bridgeStore.setLastSeen(FROM, "MAT", units)
    hashes.set(`${P9}/${FILE}`, units.blobHash)
    hashes.set(`${P10}/${FILE}`, units.blobHash)

    const r = await switchLiveCopy(LINK, copy(P10))

    expect(r.kind).toBe("moved")
    expect(await bridgeStore.link(FROM)).toBeNull()
    expect((await bridgeStore.link(TO))?.projectPath).toBe(P10)
    expect((await bridgeStore.linkForProject("proj-1"))?.projectPath).toBe(P10)
    expect((await bridgeStore.lastSeen(TO, "MAT"))?.blobHash).toBe(units.blobHash)
  })

  // A stale base or write log left in the new folder by an earlier session
  // would make Paratext's own changes read as conflicts.
  it("drops what an earlier session left for the new copy", async () => {
    const units = await seen("\\id MAT\n\\c 1\n\\v 1 One.\n")
    hashes.set(`${P9}/${FILE}`, units.blobHash)
    hashes.set(`${P10}/${FILE}`, units.blobHash)
    await bridgeStore.setLastSeen(TO, "MAT", await seen("\\id MAT\n\\c 1\n\\v 1 Old.\n"))
    await bridgeStore.recordWrites(TO, "MAT", [{ unitId: "MAT 1:1", previousRawHash: "p", newRawHash: "n" }])
    await bridgeStore.setHold(TO, "MAT", true)

    expect((await switchLiveCopy(LINK, copy(P10))).kind).toBe("moved")
    expect(await bridgeStore.lastSeen(TO, "MAT")).toBeNull()
    expect(await bridgeStore.writeLog(TO, "MAT")).toEqual([])
    expect(await bridgeStore.hold(TO, "MAT")).toBe(false)
  })

  // Different files mean one app has not run Send/Receive: switching would
  // either revert newer text or push older text. The user syncs both first.
  it("refuses when the copies' files differ, and leaves the link alone", async () => {
    hashes.set(`${P9}/${FILE}`, "a")
    hashes.set(`${P10}/${FILE}`, "b")
    const r = await switchLiveCopy(LINK, copy(P10))
    expect(r).toEqual({ kind: "blocked", block: { kind: "differs", books: ["MAT"] } })
    expect((await bridgeStore.link(FROM))?.projectPath).toBe(P9)
    expect(await bridgeStore.link(TO)).toBeNull()
  })

  it("refuses when a mirrored book is not in the new copy", async () => {
    const r = await switchLiveCopy(LINK, copy(P10, []))
    expect(r).toEqual({ kind: "blocked", block: { kind: "missing", books: ["MAT"] } })
  })

  it("refuses while a book is on hold after a clobber", async () => {
    hashes.set(`${P9}/${FILE}`, "a")
    hashes.set(`${P10}/${FILE}`, "a")
    await bridgeStore.setHold(FROM, "MAT", true)
    const r = await switchLiveCopy(LINK, copy(P10))
    expect(r).toEqual({ kind: "blocked", block: { kind: "held", books: ["MAT"] } })
  })

  // A Paratext change Aquilla has not read yet would otherwise look like an
  // Aquilla edit reverting it, and be written back over it.
  it("refuses when Aquilla has not caught up with the old copy", async () => {
    const units = await seen("\\id MAT\n\\c 1\n\\v 1 One.\n")
    await bridgeStore.setLastSeen(FROM, "MAT", units)
    hashes.set(`${P9}/${FILE}`, "newer")
    hashes.set(`${P10}/${FILE}`, "newer")
    const r = await switchLiveCopy(LINK, copy(P10))
    expect(r).toEqual({ kind: "blocked", block: { kind: "unsynced", books: ["MAT"] } })
  })
})
