// FRO-478: target.cell.repin projection tests.
//
// WHY: repin ("accept upstream change as-is") is the bulk-review-panel
// action that must NOT clobber validation state. The rules that must hold,
// byte-for-byte, per the design spec §4/§7:
//   1. Updates ONLY cells.source_event_id on the target row.
//   2. Does NOT move cells.event_id (the chain head) — validated and
//      endorsement_count must survive untouched.
//   3. Guarded by expectedTargetEventId: if the target's CURRENT event_id no
//      longer equals it (a translator re-committed), the repin is a silent
//      no-op — a race negative case the bulk-repin UI must detect and report.
//   4. Non-chain-mutating: no chain_claims row is taken.

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import type { EventPayloads } from "../events/types"

const PROJECT = "proj-repin"
const FILE = "file-a"
const CELL = "cell-1"
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
    author: "importer",
    payload: { name: "Genesis", fileType: "codex" },
    clientTs: 1,
    serverTs: 1,
  })
}

async function sourceCreate(t: TestDb, value: string): Promise<string> {
  const id = nextId("source-create")
  await apply(t, {
    id,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    kind: "source.cell.create",
    author: "importer",
    payload: { cellId: CELL, value },
    clientTs: 1,
    serverTs: 1,
  })
  return id
}

/** Commits a target.cell.commit (creates the row on first call) and returns
 *  the new event_id — this becomes the target row's chain head / event_id. */
async function targetCommit(
  t: TestDb,
  value: string,
  sourceEventId: string | null,
): Promise<string> {
  const id = nextId("target-commit")
  const payload: EventPayloads["target.cell.commit"] = { value, sourceEventId }
  await apply(t, {
    id,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    kind: "target.cell.commit",
    author: "translator",
    payload,
    clientTs: 1,
    serverTs: 1,
  })
  return id
}

async function validate(t: TestDb, editEventId: string, username = "reviewer"): Promise<void> {
  await apply(t, {
    id: nextId("validate"),
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    kind: "cell.validate",
    author: username,
    payload: { editEventId },
    clientTs: 1,
    serverTs: 1,
  })
}

async function repin(
  t: TestDb,
  sourceEventId: string,
  expectedTargetEventId: string,
): Promise<void> {
  const payload: EventPayloads["target.cell.repin"] = { sourceEventId, expectedTargetEventId }
  await apply(t, {
    id: nextId("repin"),
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId: CELL,
    parentId: null,
    kind: "target.cell.repin",
    author: "reviewer",
    payload,
    clientTs: 1,
    serverTs: 1,
  })
}

async function targetRow(t: TestDb): Promise<Record<string, unknown> | undefined> {
  const rows = await t.rows<Record<string, unknown>>("cells")
  return rows.find((r) => r.cell_id === CELL && r.side === "target")
}

describe("target.cell.repin projection", () => {
  it("updates source_event_id without moving event_id, value, validated, or endorsement_count", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const srcEvt1 = await sourceCreate(t, "In the beginning")
      const targetEvt = await targetCommit(t, "Au commencement", srcEvt1)
      await validate(t, targetEvt)

      const before = await targetRow(t)
      expect(before?.validated).toBe(1)
      expect(Number(before?.endorsement_count)).toBe(1)
      expect(before?.event_id).toBe(targetEvt)
      expect(before?.value).toBe("Au commencement")

      // Simulate the upstream source having since advanced (a new source
      // head the reviewer is repinning against).
      const srcEvt2 = await sourceCreate(t, "In the beginning (fixed)")
      await repin(t, srcEvt2, targetEvt)

      const after = await targetRow(t)
      expect(after?.source_event_id).toBe(srcEvt2)
      // Chain head, value, and validation state are UNTOUCHED.
      expect(after?.event_id).toBe(targetEvt)
      expect(after?.value).toBe("Au commencement")
      expect(after?.validated).toBe(1)
      expect(Number(after?.endorsement_count)).toBe(1)
    } finally {
      await t.close()
    }
  })

  it("no-ops when the target's current event_id no longer matches expectedTargetEventId (translator won the race)", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const srcEvt1 = await sourceCreate(t, "value 1")
      const staleTargetEvt = await targetCommit(t, "translation v1", srcEvt1)

      // Translator re-commits AFTER the reviewer opened the panel (their
      // expectedTargetEventId is now stale — the chain head moved).
      const freshTargetEvt = await targetCommit(t, "translation v2 (newer)", srcEvt1)
      expect(freshTargetEvt).not.toBe(staleTargetEvt)

      const srcEvt2 = await sourceCreate(t, "value 2 (fixed upstream)")
      // Reviewer's repin still carries the STALE expected head.
      await repin(t, srcEvt2, staleTargetEvt)

      const after = await targetRow(t)
      // The fresher pin wins: source_event_id must NOT have been overwritten
      // by the stale repin (it still reflects whatever the last real commit
      // set — srcEvt1, since target.cell.commit sets it from the payload).
      expect(after?.source_event_id).toBe(srcEvt1)
      expect(after?.source_event_id).not.toBe(srcEvt2)
      // The row still reflects the translator's newer commit.
      expect(after?.event_id).toBe(freshTargetEvt)
      expect(after?.value).toBe("translation v2 (newer)")
    } finally {
      await t.close()
    }
  })

  it("does not touch cell_validators or take a chain_claims row", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const srcEvt1 = await sourceCreate(t, "v1")
      const targetEvt = await targetCommit(t, "t1", srcEvt1)
      await validate(t, targetEvt)

      const validatorsBefore = await t.rows<Record<string, unknown>>("cell_validators")
      const srcEvt2 = await sourceCreate(t, "v2")
      await repin(t, srcEvt2, targetEvt)

      const validatorsAfter = await t.rows<Record<string, unknown>>("cell_validators")
      expect(validatorsAfter).toEqual(validatorsBefore)

      const claims = await t.rows<Record<string, unknown>>("chain_claims")
      expect(claims.filter((c) => c.cell_id === CELL)).toHaveLength(0)
    } finally {
      await t.close()
    }
  })
})
