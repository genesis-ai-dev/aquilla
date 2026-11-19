import { describe, expect, it } from "vitest"
import { bookOf, canonicalRefOf, langquestAudioId, langquestCellId, langquestFileId, planSync } from "./plan"
import type { KnownPassage, LangQuestPassage } from "./types"

const P = "proj-1"
const L = "lang-kal"

function passage(unitId: string, over: Partial<LangQuestPassage> = {}): LangQuestPassage {
  return {
    unitId,
    label: unitId,
    path: ["Genesis", "Chapter 1"],
    kind: "passage",
    order: unitId,
    reference: null,
    status: "in_review",
    version: { n: 1, takeId: `${unitId}-t1`, submittedAt: "x", durationMs: 2000 },
    approvedVersion: null,
    updatedAt: "x",
    audio: [{ hash: `h-${unitId}`, format: "wav", durationMs: 2000, url: `https://lq/api/blobs/${unitId}`, expiresAt: "x" }],
    ...over,
  }
}

describe("planSync", () => {
  it("files each book once and chains its passages in LangQuest's display order", () => {
    const plan = planSync({
      projectId: P,
      languageId: L,
      known: [],
      passages: [passage("02"), passage("01"), passage("10", { path: ["Exodus"] })],
      deletedUnitIds: [],
    })
    expect(plan.newFiles.map((f) => f.name)).toEqual(["Genesis", "Exodus"])
    const genesis = plan.newFiles[0]!
    expect(genesis.cells.map((c) => c.unitId)).toEqual(["01", "02"])
    expect(genesis.cells[0]!.anchorCellId).toBeNull()
    expect(genesis.cells[1]!.anchorCellId).toBe(genesis.cells[0]!.cellId)
  })

  it("derives the same ids on a rerun, so a sync that died halfway cannot duplicate cells", () => {
    const args = { projectId: P, languageId: L, known: [], passages: [passage("01")], deletedUnitIds: [] }
    const a = planSync(args)
    const b = planSync(args)
    expect(a.newFiles[0]!.fileId).toBe(b.newFiles[0]!.fileId)
    expect(a.newFiles[0]!.cells[0]!.eventId).toBe(b.newFiles[0]!.cells[0]!.eventId)
    // …but two projects importing the same language never share a file id.
    expect(langquestFileId("proj-2", L, "Genesis")).not.toBe(langquestFileId(P, L, "Genesis"))
  })

  it("attaches a take only when LangQuest has a version Aquilla has not imported", () => {
    const fileId = langquestFileId(P, L, "Genesis")
    const known: KnownPassage[] = [
      { unitId: "01", fileId, cellId: langquestCellId(L, "01"), label: "01", order: "01", takeId: "01-t1" },
    ]
    const same = planSync({ projectId: P, languageId: L, known, passages: [passage("01")], deletedUnitIds: [] })
    expect(same.takes).toEqual([])
    expect(same.newFiles).toEqual([])
    expect(same.newCells).toEqual([])

    const newer = planSync({
      projectId: P,
      languageId: L,
      known,
      passages: [passage("01", { version: { n: 2, takeId: "01-t2", submittedAt: "x", durationMs: 1 } })],
      deletedUnitIds: [],
    })
    expect(newer.takes.map((t) => t.takeId)).toEqual(["01-t2"])
    expect(newer.rows[0]!.takeId).toBe("01-t2")
  })

  it("does not record a version as imported when it has no audio to attach", () => {
    const plan = planSync({
      projectId: P,
      languageId: L,
      known: [],
      passages: [passage("01", { audio: [] })],
      deletedUnitIds: [],
    })
    expect(plan.takes).toEqual([])
    expect(plan.rows[0]!.takeId).toBeNull()
  })

  it("adds a new passage to its book's existing file, after the passage before it", () => {
    const fileId = langquestFileId(P, L, "Genesis")
    const known: KnownPassage[] = [
      { unitId: "01", fileId, cellId: "c01", label: "01", order: "01", takeId: null },
      { unitId: "02", fileId, cellId: "c02", label: "02", order: "02", takeId: null },
    ]
    const plan = planSync({ projectId: P, languageId: L, known, passages: [passage("03")], deletedUnitIds: [] })
    expect(plan.newFiles).toEqual([])
    expect(plan.newCells).toHaveLength(1)
    expect(plan.newCells[0]!.fileId).toBe(fileId)
    expect(plan.newCells[0]!.anchorCellId).toBe("c02")
  })

  it("removes only passages Aquilla imported", () => {
    const known: KnownPassage[] = [{ unitId: "01", fileId: "f", cellId: "c01", label: "01", order: "01", takeId: null }]
    const plan = planSync({ projectId: P, languageId: L, known, passages: [], deletedUnitIds: ["01", "never-seen"] })
    expect(plan.removed.map((r) => r.cellId)).toEqual(["c01"])
  })
})

describe("references", () => {
  it("gives a single verse a canonical ref and leaves ranges to metadata", () => {
    const ref = { book: "GEN", chapter: 1, verse: 3, endChapter: null, endVerse: null }
    expect(canonicalRefOf({ reference: ref })).toBe("GEN 1:3")
    expect(canonicalRefOf({ reference: { ...ref, endVerse: 5 } })).toBeUndefined()
    expect(canonicalRefOf({ reference: { ...ref, verse: null } })).toBeUndefined()
    expect(canonicalRefOf({ reference: null })).toBeUndefined()
  })

  it("files a passage with no path under its reference's book", () => {
    expect(bookOf({ path: [], reference: { book: "MRK", chapter: 1, verse: 1, endChapter: null, endVerse: null } })).toBe("MRK")
    expect(bookOf({ path: [], reference: null })).toBe("Passages")
  })
})

// AQU-2682 (Nov 19): a card's audio id names its VERSION too. A new LangQuest
// version that reuses a card would otherwise reuse the id of an earlier take
// (one a person may have removed, whose recording storage then keeps as that
// take's), and attaching it would bring the old take back with its old
// approvals. Still the same id on a rerun of the same version.
describe("langquestAudioId", () => {
  it("is the same for the same card of the same version, so a rerun is idempotent", () => {
    expect(langquestAudioId("cell-1234-abcd", "take-0001-x", { hash: "h1" })).toBe(langquestAudioId("cell-1234-abcd", "take-0001-x", { hash: "h1" }))
  })

  it("differs for the same card in a new version", () => {
    expect(langquestAudioId("cell-1234-abcd", "take-0001-x", { hash: "h1" })).not.toBe(langquestAudioId("cell-1234-abcd", "take-0002-y", { hash: "h1" }))
  })

  it("keeps to the storage name's characters", () => {
    expect(langquestAudioId("cell-1234-abcd", "take/0001:x", { hash: "a+b/c=" })).toMatch(/^lq-[A-Za-z0-9-]+$/)
  })
})

describe("langquestAudioId, for versions made close together", () => {
  it("two versions a second apart (time-ordered ids share their first characters) get different ids", () => {
    // uuidv7s minted 1 s apart: the same first 8 hex characters.
    const first = "019a8f3c-1a2b-7c3d-8e4f-0123456789ab"
    const second = "019a8f3c-1e13-7c3d-8e4f-0123456789ab"
    expect(first.replace(/-/g, "").slice(0, 8)).toBe(second.replace(/-/g, "").slice(0, 8))
    expect(langquestAudioId("cell-1234-abcd", first, { hash: "h1" })).not.toBe(langquestAudioId("cell-1234-abcd", second, { hash: "h1" }))
  })

  it("is still the same for the same version", () => {
    const v = "019a8f3c-1a2b-7c3d-8e4f-0123456789ab"
    expect(langquestAudioId("cell-1234-abcd", v, { hash: "h1" })).toBe(langquestAudioId("cell-1234-abcd", v, { hash: "h1" }))
  })
})
