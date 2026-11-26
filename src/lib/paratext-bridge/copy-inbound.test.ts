import { beforeEach, describe, it, expect, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"
import { bridgeStore, resetBridgeStoreForTests } from "./store"
import { bridgeStateId } from "./project"
import { deriveUnits } from "./units"
import { classifyChanges } from "./classify"
import { diffCellsAgainstUnits, type MirrorCell } from "./mirror-map"
import type { BookLocation } from "./book-sync"

const files = new Map<string, string>()
vi.mock("./tauri", () => ({
  paratextTauri: { readFile: async (dir: string, file: string) => new TextEncoder().encode(files.get(`${dir}/${file}`) ?? "") },
}))

const { classifyCopyChange, isSettled, readCopy, settleCopy } = await import("./copy-inbound")

const GUID = "6b5b95fb6e10f63cfc1868e0c972ebb302d32d3d"
const P10 = "/Users/me/.paratext-10-studio/projects/Paratext 9 Projects/TPP1"
const FILE = "41MATTPP1.SFM"
const LOC: BookLocation = { projectPath: P10, fileName: FILE, stateId: bridgeStateId(GUID, P10) }

const book = (v1: string, v2: string) => `\\id MAT - Test\n\\c 1\n\\p\n\\v 1 ${v1}\n\\v 2 ${v2}\n`
const units = (v1: string, v2: string) => deriveUnits(new TextEncoder().encode(book(v1, v2)))
const cells = (v1: string | undefined, v2: string | undefined): MirrorCell[] => [
  { cellId: "c1", ref: "MAT 1:1", ...(v1 === undefined ? {} : { value: v1 }) },
  { cellId: "c2", ref: "MAT 1:2", ...(v2 === undefined ? {} : { value: v2 }) },
]
const refs = (us: { ref: string }[]) => us.map((u) => u.ref)

describe("classifyCopyChange: an edit made in a copy Aquilla does not write to", () => {
  it("lands an edit the translator made in Paratext 10 while the cell still held that copy's old text", async () => {
    const r = classifyCopyChange(await units("Old one.", "Two."), await units("New one.", "Two."), cells("Old one.", "Two."))
    expect(refs(r.land)).toEqual(["MAT 1:1"])
    expect(r.land[0].text).toContain("New one.")
    expect(r.held).toEqual([])
  })

  it("never overwrites an Aquilla edit: a verse both changed is held, not landed", async () => {
    const r = classifyCopyChange(await units("Old one.", "Two."), await units("Paratext 10 one.", "Two."), cells("Aquilla one.", "Two."))
    expect(r.land).toEqual([])
    expect(refs(r.held)).toEqual(["MAT 1:1"])
  })

  it("does nothing when Send/Receive brings the copy the text Aquilla already has", async () => {
    // The Paratext 9 edit reached the cell first; Paratext 10 received it later.
    const r = classifyCopyChange(await units("Old one.", "Two."), await units("New one.", "Two."), cells("New one.", "Two."))
    expect(r).toEqual({ land: [], held: [] })
  })

  it("fills a verse that has no translation in Aquilla yet", async () => {
    const r = classifyCopyChange(await units("One.", ""), await units("One.", "Two, first draft."), cells("One.", undefined))
    expect(refs(r.land)).toEqual(["MAT 1:2"])
  })

  it("ignores verses the copy did not touch, even where the cell differs from it", async () => {
    // The copies differ between Send/Receives; that difference is not an edit.
    const same = await units("Stale in this copy.", "Two.")
    expect(classifyCopyChange(same, same, cells("Newer in the live copy.", "Two."))).toEqual({ land: [], held: [] })
  })
})

describe("readCopy / settleCopy", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBridgeStoreForTests()
    files.clear()
  })

  it("takes the file as the base on first read, so a copy that is behind brings nothing in", async () => {
    files.set(`${P10}/${FILE}`, book("Behind.", "Two."))
    const r = await readCopy(LOC, cells("Ahead in the live copy.", "Two."))
    expect(r.land).toEqual([])
    expect(r.held).toEqual([])
    expect((await bridgeStore.lastSeen(LOC.stateId, "MAT"))?.blobHash).toBe(r.units.blobHash)
  })

  it("lands a later edit once and then treats the file as read", async () => {
    await bridgeStore.setLastSeen(LOC.stateId, "MAT", await units("Old one.", "Two."))
    files.set(`${P10}/${FILE}`, book("New one.", "Two."))
    const r = await readCopy(LOC, cells("Old one.", "Two."))
    expect(refs(r.land)).toEqual(["MAT 1:1"])
    await settleCopy(LOC, r)
    const again = await readCopy(LOC, cells("New one.", "Two."))
    expect(again.land).toEqual([])
  })

  it("keeps reporting a held verse after a restart, and stops once the texts agree", async () => {
    await bridgeStore.setLastSeen(LOC.stateId, "MAT", await units("Old one.", "Two."))
    files.set(`${P10}/${FILE}`, book("Paratext 10 one.", "Two."))
    const first = await readCopy(LOC, cells("Aquilla one.", "Two."))
    await settleCopy(LOC, first)
    // Base did not move: a fresh session reads the same change again.
    resetBridgeStoreForTests()
    expect(refs((await readCopy(LOC, cells("Aquilla one.", "Two."))).held)).toEqual(["MAT 1:1"])
    // Send/Receive merged the verse and the live copy brought the result in.
    const merged = await readCopy(LOC, cells("Paratext 10 one.", "Two."))
    expect(merged.held).toEqual([])
    await settleCopy(LOC, merged)
    expect((await bridgeStore.lastSeen(LOC.stateId, "MAT"))?.blobHash).toBe(merged.units.blobHash)
  })
})

describe("isSettled: the live copy receives a change Aquilla already read from another copy", () => {
  it("is no conflict when both sides hold the same text, and still one when they differ", async () => {
    // The cell took "New one." from Paratext 10; the live copy still had "Old one.".
    const lastSeen = await units("Old one.", "Two.")
    const classify = async (fileV1: string) => classifyChanges({
      lastSeen, current: await units(fileV1, "Two."),
      pending: diffCellsAgainstUnits(cells("New one.", "Two."), lastSeen).edits, written: [],
    }).units.filter((u) => u.case === "both-changed")
    const same = await classify("New one.")
    expect(same).toHaveLength(1)
    expect(isSettled(same[0])).toBe(true)
    const differs = await classify("Third text.")
    expect(isSettled(differs[0])).toBe(false)
  })
})
