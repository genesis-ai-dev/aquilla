// AQU-2185: source.cell.milestone.set projection tests.
//
// WHY THIS KIND EXISTS AT ALL: every navigator division used to come either out
// of the imported file or out of the app's own fallback ("Part N", 5-minute
// buckets, AI-cut sections), and nobody could add one. A team on a transcript
// or a recording got arbitrary 50-line or 5-minute chunks that did not follow
// the story, and could not divide the work the way they planned it.
//
// As with the hide beside it, the whole contract of this event is what it does
// NOT do, and that is what this suite pins:
//
//   1. Moves ONLY cells.milestone_label, and only on the SOURCE row (lane '').
//      One row answers for every lane, because a division belongs to the file
//      they all share.
//   2. Does NOT move cells.event_id — AD-9 reads the source head as "the content
//      changed", so a marker that advanced it would false-flag every lane's
//      translation as stale. Naming a division says nothing about the text.
//   3. Destroys nothing: the source text, every lane's target row and its
//      validation state are exactly as they were, so clearing the marker
//      round-trips byte-for-byte.
//   4. Reversible: `label: null` clears the column back to NULL, and the file's
//      own divisions stand again (the division itself is derived, never stored).
//   5. Survives a re-import. The `source.cell.create` UPSERT overwrites the
//      per-cell metadata bucket wholesale, which is precisely why the label is a
//      column and not a metadata key — this suite is what would catch a future
//      change putting it back in `metadata`, where the next re-import of the
//      file would silently drop every hand-set section.
//   6. Non-chain-mutating: a rebuild replays it unconditionally in seq order, so
//      the last set/clear wins.
//   7. Refuses a blank label rather than folding it into a clear — `""` is a
//      mis-send, and treating it as a clear would delete a section nobody asked
//      to remove.

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, isChainMutatingKind, type PersistedEvent } from "../events/event-projection"
import { REQUIRED_ROLE, ROLE } from "../events/role-policy"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import type { EventPayloads } from "../events/types"

const PROJECT = "proj-handset"
const FILE = "file-a"
let _seq = 0

async function apply(t: TestDb, event: PersistedEvent): Promise<void> {
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  for (let i = 0; i < stmts.length; i += 100) {
    await t.db.batch(stmts.slice(i, i + 100))
  }
}

function nextId(prefix: string): string {
  _seq += 1
  return `${prefix}-${_seq}`
}

async function fileCreate(t: TestDb): Promise<void> {
  await apply(t, {
    id: nextId("file-create"),
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: null,
    parentId: null,
    kind: "file.create",
    author: "lead",
    payload: { name: "Transcript", fileType: "codex" },
    clientTs: 1,
    serverTs: 1,
  })
}

async function sourceCreate(t: TestDb, cellId: string, value = `src ${cellId}`): Promise<string> {
  const id = nextId("source-create")
  await apply(t, {
    id,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
    kind: "source.cell.create",
    author: "lead",
    payload: { cellId, value, anchorCellId: null },
    clientTs: 1,
    serverTs: 1,
  })
  return id
}

async function targetCommit(
  t: TestDb,
  cellId: string,
  sourceEventId: string,
  targetLang = "",
  value = `tgt ${cellId} ${targetLang}`,
): Promise<string> {
  const id = nextId("target-commit")
  await apply(t, {
    id,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: sourceEventId,
    kind: "target.cell.commit",
    author: "translator",
    payload: { value, sourceEventId, ...(targetLang ? { targetLang } : {}) },
    clientTs: 2,
    serverTs: 2,
  })
  return id
}

function milestoneEvent(cellId: string, label: string | null, serverTs = 50): PersistedEvent {
  const payload: EventPayloads["source.cell.milestone.set"] = { label }
  return {
    id: nextId("milestone"),
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
    kind: "source.cell.milestone.set",
    author: "lead",
    payload,
    clientTs: serverTs,
    serverTs,
  }
}

async function setMilestone(
  t: TestDb,
  cellId: string,
  label: string | null,
  serverTs = 50,
): Promise<void> {
  await apply(t, milestoneEvent(cellId, label, serverTs))
}

async function rows(t: TestDb, cellId: string): Promise<Record<string, unknown>[]> {
  const all = await t.rows<Record<string, unknown>>("cells")
  return all
    .filter((r) => r.cell_id === cellId)
    .sort((a, b) =>
      `${a.side}\u0000${a.target_lang ?? ""}`.localeCompare(`${b.side}\u0000${b.target_lang ?? ""}`),
    )
}

async function row(
  t: TestDb,
  cellId: string,
  side: "source" | "target",
  targetLang = "",
): Promise<Record<string, unknown> | undefined> {
  return (await rows(t, cellId)).find((r) => r.side === side && (r.target_lang ?? "") === targetLang)
}

describe("source.cell.milestone.set projection", () => {
  it("stores the label on the source row without moving the head or the staleness pin", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v70")
      const commitEvt = await targetCommit(t, "v70", createEvt)

      await setMilestone(t, "v70", "The storm", 77)

      const source = await row(t, "v70", "source")
      expect(source?.milestone_label).toBe("The storm")
      // The head did NOT move, so the target's AD-9 pin still matches it and the
      // translation is NOT stale. Naming a division says nothing about its text.
      expect(source?.event_id).toBe(createEvt)
      const target = await row(t, "v70", "target")
      expect(target?.source_event_id).toBe(createEvt)
      expect(target?.event_id).toBe(commitEvt)
    } finally {
      await t.close()
    }
  })

  it("leaves the label off the target rows — one source row answers for every lane", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v70")
      await targetCommit(t, "v70", createEvt, "")
      await targetCommit(t, "v70", createEvt, "fr")

      await setMilestone(t, "v70", "The storm")

      // Deliberate: consumers resolve a cell's section from the SOURCE row. A
      // target row created AFTER the marker carries no label of its own, and
      // must still land in the section.
      expect((await row(t, "v70", "target", ""))?.milestone_label ?? null).toBeNull()
      expect((await row(t, "v70", "target", "fr"))?.milestone_label ?? null).toBeNull()
      expect((await row(t, "v70", "source"))?.milestone_label).toBe("The storm")
    } finally {
      await t.close()
    }
  })

  it("trims the stored label, so a stray space cannot make two sections of one", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v70")

      await setMilestone(t, "v70", "  The storm  ")

      expect((await row(t, "v70", "source"))?.milestone_label).toBe("The storm")
    } finally {
      await t.close()
    }
  })

  it("destroys nothing: every row and value survives a set/clear round trip", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v70", "In the beginning")
      await targetCommit(t, "v70", createEvt, "", "Au commencement")
      await targetCommit(t, "v70", createEvt, "es", "En el principio")
      const before = await rows(t, "v70")

      await setMilestone(t, "v70", "The storm", 60)
      await setMilestone(t, "v70", null, 61)

      // Byte-for-byte: the label is the ONLY thing that moved, and it came back
      // to NULL. The file's own divisions stand again, because the division was
      // never stored — only this label was.
      expect(await rows(t, "v70")).toEqual(before)
    } finally {
      await t.close()
    }
  })

  it("survives a re-import, which is why the label is a column and not a metadata key", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v70", "first import")
      await setMilestone(t, "v70", "The storm")

      // The re-import's UPSERT overwrites value and the metadata bucket
      // wholesale. `milestone_label` is absent from its SET list, so it stands.
      await sourceCreate(t, "v70", "second import")

      const source = await row(t, "v70", "source")
      expect(source?.value).toBe("second import")
      expect(source?.milestone_label).toBe("The storm")
    } finally {
      await t.close()
    }
  })

  it("replays in seq order on a rebuild, so the last set or clear wins", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v70")

      await setMilestone(t, "v70", "The storm", 10)
      await setMilestone(t, "v70", "The calm", 20)

      expect((await row(t, "v70", "source"))?.milestone_label).toBe("The calm")

      await setMilestone(t, "v70", null, 30)
      expect((await row(t, "v70", "source"))?.milestone_label ?? null).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("refuses a blank label instead of treating it as a clear", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v70")
      await setMilestone(t, "v70", "The storm")

      const stmts: AquillaStatement[] = []
      expect(() => buildEventProjectionStmts(
        t.db,
        { ...milestoneEvent("v70", "   ", 90) },
        stmts,
      )).toThrow(/non-blank/)
      // And the section that was there is untouched, because nothing ran.
      expect((await row(t, "v70", "source"))?.milestone_label).toBe("The storm")
    } finally {
      await t.close()
    }
  })

  it("refuses an event with no cell to mark", async () => {
    const t = await makeTestDb()
    try {
      const stmts: AquillaStatement[] = []
      expect(() => buildEventProjectionStmts(
        t.db,
        { ...milestoneEvent("v70", "The storm"), cellId: null },
        stmts,
      )).toThrow(/missing fileId or cellId/)
    } finally {
      await t.close()
    }
  })
})

describe("source.cell.milestone.set contract", () => {
  it("is not chain-mutating", () => {
    // A chain-mutating event with a null parent would lose first-child
    // arbitration to the genesis create and evaporate; and moving the head
    // would make every lane's translation stale for a change to no text.
    expect(isChainMutatingKind("source.cell.milestone.set")).toBe(false)
  })

  it("needs the same role as editing the source text", () => {
    // Re-dividing the file changes how the whole team plans, assigns and reports
    // on the work — the source.cell.commit class of decision, not the low-floored
    // create/delete/reorder trio that re-import and DCS repair emit.
    expect(REQUIRED_ROLE["source.cell.milestone.set"]).toBe(ROLE.PROJECT_LEAD)
    expect(REQUIRED_ROLE["source.cell.milestone.set"]).toBe(REQUIRED_ROLE["source.cell.commit"])
    expect(REQUIRED_ROLE["source.cell.milestone.set"]).toBeGreaterThan(
      REQUIRED_ROLE["source.cell.create"],
    )
  })
})
