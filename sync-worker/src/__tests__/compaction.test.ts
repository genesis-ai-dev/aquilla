// Verifies the invariant the sync-worker's compaction path relies on:
// Y.mergeUpdates([snapshot, ...tails]) produces a single update blob that,
// when applied to a fresh Y.Doc, recreates the exact state of replaying
// snapshot + each tail in sequence. If this ever regresses in Yjs, compaction
// would silently drop edits; this test pins the behaviour.

import { describe, it, expect } from "vitest"
import * as Y from "yjs"

function encodeAfter(mutate: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => mutate(doc))
  const state = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return state
}

function encodeIncrementalUpdates(
  baseline: Uint8Array,
  mutate: (doc: Y.Doc) => void
): Uint8Array {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, baseline)
  const prev = Y.encodeStateVector(doc)
  doc.transact(() => mutate(doc))
  const tail = Y.encodeStateAsUpdate(doc, prev)
  doc.destroy()
  return tail
}

describe("Y.mergeUpdates → replay invariant", () => {
  it("merges snapshot + tails into a single blob that reproduces cell state", () => {
    // Snapshot: one cell with some initial text.
    const snapshot = encodeAfter((doc) => {
      const cells = doc.getMap("cells")
      const cell = new Y.Map()
      cell.set("id", "cell-1")
      const frag = new Y.XmlFragment()
      cell.set("translatedXml", frag)
      const p = new Y.XmlElement("paragraph")
      const t = new Y.XmlText()
      t.insert(0, "hello")
      p.insert(0, [t])
      frag.insert(0, [p])
      cells.set("cell-1", cell)
    })

    // Tail 1: add a second cell.
    const tail1 = encodeIncrementalUpdates(snapshot, (doc) => {
      const cells = doc.getMap("cells")
      const cell = new Y.Map()
      cell.set("id", "cell-2")
      cells.set("cell-2", cell)
    })

    // Tail 2: mutate cell-1's history array.
    const tail2 = encodeIncrementalUpdates(
      Y.mergeUpdates([snapshot, tail1]),
      (doc) => {
        const cells = doc.getMap("cells")
        const cell = cells.get("cell-1") as Y.Map<unknown>
        const history = new Y.Array<{ value: string; timestamp: string }>()
        history.push([{ value: "hello", timestamp: "2026-04-21T00:00:00Z" }])
        cell.set("history", history)
      }
    )

    // Replay-in-sequence reference doc.
    const refDoc = new Y.Doc()
    Y.applyUpdate(refDoc, snapshot)
    Y.applyUpdate(refDoc, tail1)
    Y.applyUpdate(refDoc, tail2)

    // Merged single-blob path.
    const merged = Y.mergeUpdates([snapshot, tail1, tail2])
    const mergedDoc = new Y.Doc()
    Y.applyUpdate(mergedDoc, merged)

    // Both paths must agree on final state.
    const refCells = refDoc.getMap("cells")
    const mergedCells = mergedDoc.getMap("cells")
    expect(mergedCells.size).toBe(refCells.size)
    expect(mergedCells.size).toBe(2)

    const refHist = (refCells.get("cell-1") as Y.Map<unknown>).get("history") as Y.Array<unknown>
    const mergedHist = (mergedCells.get("cell-1") as Y.Map<unknown>).get("history") as Y.Array<unknown>
    expect(mergedHist.toArray()).toEqual(refHist.toArray())

    refDoc.destroy()
    mergedDoc.destroy()
  })

  it("merging a list that contains duplicates is idempotent", () => {
    const update = encodeAfter((doc) => {
      doc.getMap("x").set("k", "v")
    })
    const merged = Y.mergeUpdates([update, update, update])
    const doc = new Y.Doc()
    Y.applyUpdate(doc, merged)
    expect(doc.getMap("x").get("k")).toBe("v")
    doc.destroy()
  })

  it("returns a usable merged update when tails is empty", () => {
    const snapshot = encodeAfter((doc) => {
      doc.getMap("m").set("k", 1)
    })
    const merged = Y.mergeUpdates([snapshot])
    const doc = new Y.Doc()
    Y.applyUpdate(doc, merged)
    expect(doc.getMap("m").get("k")).toBe(1)
    doc.destroy()
  })
})
