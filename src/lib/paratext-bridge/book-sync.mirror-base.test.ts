import { beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"

const disk = vi.hoisted(() => ({ bytes: new Uint8Array() }))
vi.mock("./tauri", () => ({
  paratextTauri: { readFile: async () => disk.bytes },
}))

import { bridgeStore, resetBridgeStoreForTests } from "./store"
import { deriveUnits } from "./units"
import { diffCellsAgainstUnits, type MirrorCell } from "./mirror-map"
import { reconcileBook, setMirrorBase } from "./book-sync"

const GUID = "6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d"
const LOC = { projectPath: "/pt/TPP1", fileName: "41MATTPP1.SFM", guid: GUID }
const enc = (s: string) => new TextEncoder().encode(s)

const OLD = enc("\\id MAT\n\\c 1\n\\v 1 One.\n\\v 2 Two.\n")
const NOW = enc("\\id MAT\n\\c 1\n\\v 1 One.\n\\v 2 Two, edited in Paratext.\n")

/** The cells a mirror import of `bytes` produces: one per unit, same text. */
async function importedCells(bytes: Uint8Array): Promise<MirrorCell[]> {
  const units = await deriveUnits(bytes)
  return units.units.map((u, i) => ({ cellId: `c${i}`, ref: u.ref, value: u.text }))
}

/** What the mirror's first sync does: diff cells against the base, classify. */
async function firstSync(cells: MirrorCell[]) {
  const base = await bridgeStore.lastSeen(GUID, "MAT")
  const pending = base ? diffCellsAgainstUnits(cells, base).edits : []
  return { pending, reconcile: await reconcileBook(LOC, { pending }) }
}

// The base ("last seen") is keyed by Paratext project GUID, so it outlives the
// session that wrote it. A mirror created later imports the file as it is NOW;
// if the old base stays, every verse Paratext changed in between looks edited
// by both sides and the translator is asked to choose between identical texts,
// with those verses also counted as waiting to be written.
describe("setMirrorBase", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
    disk.bytes = NOW
  })

  it("reproduces the false conflict when a stale base is left in place", async () => {
    await bridgeStore.setLastSeen(GUID, "MAT", await deriveUnits(OLD))
    const { pending, reconcile } = await firstSync(await importedCells(NOW))
    expect(pending.map((e) => e.unitId)).toEqual(["MAT 1:2"])
    expect(reconcile.conflicts.map((c) => c.unitId)).toEqual(["MAT 1:2"])
  })

  it("makes the imported bytes the base, so a fresh mirror has nothing pending and no conflicts", async () => {
    await bridgeStore.setLastSeen(GUID, "MAT", await deriveUnits(OLD))
    await setMirrorBase(GUID, [NOW])
    const { pending, reconcile } = await firstSync(await importedCells(NOW))
    expect(pending).toEqual([])
    expect(reconcile.conflicts).toEqual([])
    expect(reconcile.theirs).toEqual([])
  })

  it("still reports a Paratext edit made after the import as theirs", async () => {
    await setMirrorBase(GUID, [OLD])
    const { pending, reconcile } = await firstSync(await importedCells(OLD))
    expect(pending).toEqual([])
    expect(reconcile.conflicts).toEqual([])
    expect(reconcile.theirs.map((u) => u.unitId)).toEqual(["MAT 1:2"])
  })

  it("leaves a book's base alone when its bytes cannot be read as a book", async () => {
    const old = await deriveUnits(OLD)
    await bridgeStore.setLastSeen(GUID, "MAT", old)
    await setMirrorBase(GUID, [new Uint8Array([0xff, 0xfe, 0x00])])
    expect((await bridgeStore.lastSeen(GUID, "MAT"))?.blobHash).toBe(old.blobHash)
  })
})
