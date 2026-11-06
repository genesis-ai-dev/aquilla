import { describe, it, expect } from "vitest"
import { deriveUnits } from "./units"
import { planWriteBack } from "./write-back"
import { classifyChanges, keepMine } from "./classify"

const enc = new TextEncoder()
const BOOK = "\\id MAT\n\\c 1\n\\v 1 One.\n\\v 2 Two.\n\\v 3 Three.\n"

/** Simulate: Aquilla writes v1; Paratext (holding a stale copy) saves and reverts
 *  v1 while editing v3. */
async function scenario() {
  const base = enc.encode(BOOK)
  const baseSet = await deriveUnits(base)
  const plan = await planWriteBack(base, [{ unitId: "MAT 1:1", text: "Uno.", baseRawHash: baseSet.units[0].rawHash }])
  const afterWrite = plan.after!
  // Paratext's save: v1 back to "One." (stale), v3 changed by the user.
  const paratext = enc.encode(BOOK.replace("Three.", "Tres."))
  const current = await deriveUnits(paratext)
  return { baseSet, afterWrite, current, written: plan.applied, ownBlobHashes: new Set([afterWrite.blobHash]) }
}

describe("classifyChanges", () => {
  it("recognises a stale revert of Aquilla's own write and keeps mine", async () => {
    const s = await scenario()
    const r = classifyChanges({ lastSeen: s.afterWrite, current: s.current, pending: [], written: s.written }, s.ownBlobHashes)
    expect(r.echo).toBe(false)
    expect(r.clobbers).toBe(1)
    const v1 = r.units.find((u) => u.unitId === "MAT 1:1")!
    expect(v1.case).toBe("stale-revert")
    expect(v1.mine).toBe("Uno.")
    expect(v1.theirs?.text).toBe("One.")
    const v3 = r.units.find((u) => u.unitId === "MAT 1:3")!
    expect(v3.case).toBe("theirs-only")
    expect(r.units.find((u) => u.unitId === "MAT 1:2")).toBeUndefined()
  })

  it("keepMine re-bases the edit on theirs so write-back checks still apply", async () => {
    const s = await scenario()
    const r = classifyChanges({ lastSeen: s.afterWrite, current: s.current, pending: [], written: s.written })
    const v1 = r.units.find((u) => u.unitId === "MAT 1:1")!
    const edit = keepMine(v1)!
    expect(edit).toEqual({ unitId: "MAT 1:1", text: "Uno.", baseRawHash: v1.theirs!.rawHash })
    const plan = await planWriteBack(enc.encode(BOOK.replace("Three.", "Tres.")), [edit])
    expect(plan.ok).toBe(true)
  })

  it("an echo of Aquilla's own write is ignored", async () => {
    const s = await scenario()
    const r = classifyChanges({ lastSeen: s.baseSet, current: s.afterWrite, pending: [], written: s.written }, s.ownBlobHashes)
    expect(r.echo).toBe(true)
    expect(r.units).toEqual([])
  })

  it("both-changed when the file shows a third value where Aquilla has a pending edit", async () => {
    const base = await deriveUnits(enc.encode(BOOK))
    const current = await deriveUnits(enc.encode(BOOK.replace("Two.", "Deux.")))
    const r = classifyChanges({
      lastSeen: base, current,
      pending: [{ unitId: "MAT 1:2", text: "Dos.", baseRawHash: base.units[1].rawHash }],
      written: [],
    })
    expect(r.units).toMatchObject([{ unitId: "MAT 1:2", case: "both-changed", mine: "Dos." }])
  })

  it("mine-pending when the file is unchanged at a unit Aquilla has not written yet", async () => {
    const base = await deriveUnits(enc.encode(BOOK))
    const r = classifyChanges({
      lastSeen: base, current: base,
      pending: [{ unitId: "MAT 1:2", text: "Dos.", baseRawHash: base.units[1].rawHash }],
      written: [],
    })
    expect(r.units).toMatchObject([{ unitId: "MAT 1:2", case: "mine-pending" }])
  })

  it("reports structural adds and removals by ID", async () => {
    const base = await deriveUnits(enc.encode(BOOK))
    const current = await deriveUnits(enc.encode("\\id MAT\n\\c 1\n\\v 1 One.\n\\v 2-3 Two three.\n"))
    const r = classifyChanges({ lastSeen: base, current, pending: [], written: [] })
    expect(r.added).toEqual(["MAT 1:2-3"])
    expect(r.removed.sort()).toEqual(["MAT 1:2", "MAT 1:3"])
  })
})
