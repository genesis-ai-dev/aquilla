// AQU-1422: source.cell.visibility.set projection tests.
//
// WHY THIS KIND EXISTS AT ALL: the only way to keep a cell out of translation was
// `source.cell.delete`, which HARD-DELETES the projection row. Partners want to
// park a stray heading without losing anything. So the whole contract of this
// event is what it does NOT do, and that is what this suite pins:
//
//   1. Moves ONLY cells.hidden_at, and only on the SOURCE row (lane '').
//   2. Does NOT move cells.event_id — the AD-9 staleness comparison reads the
//      source head as "the content changed", so a hide that advanced it would
//      false-flag every lane's translation as stale. Hiding says nothing about
//      the text.
//   3. Destroys nothing: the source text, every lane's target row, its
//      validation state and the events log are all exactly as they were, so a
//      show round-trips byte-for-byte.
//   4. Reversible: `hidden: false` clears the column back to NULL.
//   5. Survives a re-import. The `source.cell.create` UPSERT overwrites the
//      per-cell metadata bucket wholesale, which is the reason the flag is a
//      column and not a metadata key — this suite is what would catch a future
//      change putting it back in `metadata`.
//   6. Non-chain-mutating: a rebuild replays it unconditionally in seq order, so
//      the last hide/show wins (a chain-mutating event with a null parent would
//      lose first-child arbitration to the genesis create and evaporate).

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, isChainMutatingKind, type PersistedEvent } from "../events/event-projection"
import { REQUIRED_ROLE, ROLE } from "../events/role-policy"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { mapCellRow, type CellRowRaw } from "../events/cell-row-serialize"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import type { EventPayloads } from "../events/types"

const SECRET = "hidden-cells-read-secret"

const PROJECT = "proj-hidden"
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
    payload: { name: "Genesis", fileType: "codex" },
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

async function setHidden(t: TestDb, cellId: string, hidden: boolean, serverTs = 50): Promise<void> {
  const payload: EventPayloads["source.cell.visibility.set"] = { hidden }
  await apply(t, {
    id: nextId("visibility"),
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
    kind: "source.cell.visibility.set",
    author: "lead",
    payload,
    clientTs: serverTs,
    serverTs,
  })
}

/** This cell's rows, in a stable order — a bare SELECT's row order is not
 *  guaranteed, and the round-trip test below compares two snapshots wholesale. */
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

describe("source.cell.visibility.set projection", () => {
  it("stamps hidden_at on the source row without moving the head or the staleness pin", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v1")
      const commitEvt = await targetCommit(t, "v1", createEvt)

      await setHidden(t, "v1", true, 77)

      const source = await row(t, "v1", "source")
      expect(source?.hidden_at).toBe(77)
      // The head did NOT move, so the target's AD-9 pin still matches it and the
      // translation is NOT stale. Hiding a cell says nothing about its text.
      expect(source?.event_id).toBe(createEvt)
      const target = await row(t, "v1", "target")
      expect(target?.source_event_id).toBe(createEvt)
      expect(target?.event_id).toBe(commitEvt)
    } finally {
      await t.close()
    }
  })

  it("leaves the flag off the target rows — one source row answers for every lane", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v1")
      await targetCommit(t, "v1", createEvt, "")
      await targetCommit(t, "v1", createEvt, "fr")

      await setHidden(t, "v1", true)

      // Deliberate: consumers resolve a cell's visibility from the SOURCE row.
      // Stamping each target row instead would strand a target created AFTER the
      // hide — the in-flight translation that must survive — with no flag.
      expect((await row(t, "v1", "target", ""))?.hidden_at ?? null).toBeNull()
      expect((await row(t, "v1", "target", "fr"))?.hidden_at ?? null).toBeNull()
      expect((await row(t, "v1", "source"))?.hidden_at).not.toBeNull()
    } finally {
      await t.close()
    }
  })

  it("destroys nothing: every row and value survives a hide/show round trip", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v1", "In the beginning")
      await targetCommit(t, "v1", createEvt, "", "Au commencement")
      await targetCommit(t, "v1", createEvt, "es", "En el principio")
      const before = await rows(t, "v1")

      await setHidden(t, "v1", true)
      await setHidden(t, "v1", false, 90)

      const after = await rows(t, "v1")
      expect(after).toHaveLength(before.length)
      // hidden_at is back to NULL and nothing else moved — compare the rows
      // wholesale rather than field by field, so a future change that quietly
      // touches value/validated/event_id on this path fails here.
      expect(after).toEqual(before)
    } finally {
      await t.close()
    }
  })

  it("clears hidden_at on show", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v1")
      await setHidden(t, "v1", true)
      expect((await row(t, "v1", "source"))?.hidden_at).not.toBeNull()

      await setHidden(t, "v1", false, 90)

      expect((await row(t, "v1", "source"))?.hidden_at ?? null).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("survives a re-import of the same cell", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v1", "first import")
      await setHidden(t, "v1", true, 77)

      // A re-import re-emits the create, whose UPSERT overwrites value AND the
      // metadata bucket wholesale. That clobbering is exactly why the flag is a
      // column: it is absent from the UPSERT's SET list, so it survives.
      await sourceCreate(t, "v1", "second import")

      const source = await row(t, "v1", "source")
      expect(source?.value).toBe("second import")
      expect(source?.hidden_at).toBe(77)
    } finally {
      await t.close()
    }
  })

  it("only touches the named cell", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v1")
      await sourceCreate(t, "v2")

      await setHidden(t, "v1", true)

      expect((await row(t, "v1", "source"))?.hidden_at).not.toBeNull()
      expect((await row(t, "v2", "source"))?.hidden_at ?? null).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("rejects a payload without a boolean `hidden`", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v1")
      const stmts: AquillaStatement[] = []
      expect(() =>
        buildEventProjectionStmts(
          t.db,
          {
            id: "bad-visibility",
            schemaVersion: 1,
            projectId: PROJECT,
            fileId: FILE,
            cellId: "v1",
            parentId: null,
            kind: "source.cell.visibility.set",
            author: "lead",
            // A forged/garbled payload must fail loudly rather than silently
            // clearing the flag (`undefined` would UPDATE hidden_at to NULL).
            payload: {} as EventPayloads["source.cell.visibility.set"],
            clientTs: 1,
            serverTs: 1,
          },
          stmts,
        ),
      ).toThrow(/boolean payload\.hidden/)
    } finally {
      await t.close()
    }
  })
})

describe("source.cell.visibility.set contract", () => {
  it("is NOT chain-mutating, so a rebuild replays it in seq order", () => {
    // A chain-mutating kind with a null parent would lose first-child
    // arbitration to the genesis create, and the hide would evaporate on every
    // projection rebuild.
    expect(isChainMutatingKind("source.cell.visibility.set")).toBe(false)
  })

  it("floors at PROJECT_LEAD, with source.cell.commit and not with the create/delete trio", () => {
    // Hiding takes a cell out of translation and out of every export, in every
    // lane, for everyone — a decision about what the file contains. The
    // create/delete/reorder trio sits at COMMENTER because re-import, DCS repair
    // and diarization all emit those through a user's own outbox; nothing emits
    // this but a person choosing it.
    expect(REQUIRED_ROLE["source.cell.visibility.set"]).toBe(ROLE.PROJECT_LEAD)
    expect(REQUIRED_ROLE["source.cell.visibility.set"]).toBe(REQUIRED_ROLE["source.cell.commit"])
    expect(REQUIRED_ROLE["source.cell.visibility.set"]).toBeGreaterThan(
      REQUIRED_ROLE["source.cell.delete"],
    )
  })
})


// AQU-1422 / AGENTS.md rule 12: the PRODUCER's output through its immediate
// CONSUMER.
//
// The projection writes `cells.hidden_at`; the read route has to turn that into
// the `hidden` flag the client filters its display list on. Those are two files
// that know nothing about each other, and the tests above only cover the first.
// A change to either column name or key — or a forgotten entry in the read
// route's column list, which is a private copy of the shared one — would leave
// both suites green and the feature silently dead: every parked cell would come
// back visible on reload, which is the exact Codex failure this replaces.
describe("a hide reaches the client through the read route", () => {
  it("reports hidden:true on the source row and omits the key on visible rows", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      const createEvt = await sourceCreate(t, "v1")
      await targetCommit(t, "v1", createEvt)
      await sourceCreate(t, "v2")
      await setHidden(t, "v1", true)

      const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
      const res = (await handleCellsReadRequest(
        new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
      ))!
      expect(res.status).toBe(200)
      const body = (await res.json()) as { cells: Record<string, unknown>[] }

      const hiddenSource = body.cells.find((c) => c.cellId === "v1" && c.side === "source")
      expect(hiddenSource?.hidden).toBe(true)
      // Absent, not `false`: a 30k-cell Bible file would otherwise pay ~15 bytes
      // per row for a field that is false on effectively all of them.
      const visible = body.cells.find((c) => c.cellId === "v2" && c.side === "source")
      expect(visible).toBeDefined()
      expect("hidden" in (visible as object)).toBe(false)
      // The target row of a hidden cell carries no flag — the client reads the
      // cell's visibility off the SOURCE row, which is the only place it lives.
      const hiddenTarget = body.cells.find((c) => c.cellId === "v1" && c.side === "target")
      expect(hiddenTarget).toBeDefined()
      expect("hidden" in (hiddenTarget as object)).toBe(false)
    } finally {
      await t.close()
    }
  })

  it("reports the cell visible again after a show, on the targeted by-ids path too", async () => {
    const t = await makeTestDb()
    try {
      await fileCreate(t)
      await sourceCreate(t, "v1")
      await setHidden(t, "v1", true)
      await setHidden(t, "v1", false, 90)

      const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
      // The by-ids path is what a live `event.applied` refetch uses, so it has to
      // agree with the full read — it reads through a second, private copy of the
      // column list.
      const res = (await handleCellsReadRequest(
        new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells?cellIds=v1`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
      ))!
      const body = (await res.json()) as { cells: Record<string, unknown>[] }

      const source = body.cells.find((c) => c.side === "source")
      expect(source).toBeDefined()
      expect("hidden" in (source as object)).toBe(false)
    } finally {
      await t.close()
    }
  })

  it("the shared serialiser agrees with the route's copy", () => {
    // `cell-row-serialize.ts` and `cells-read-route.ts` hold duplicate column
    // lists and mappers (there is a SWARM-TODO to merge them). Until they are
    // one, this pins the field both must emit — the frame path uses the shared
    // one, the read path its copy, and the client cannot tell them apart.
    const raw = { hidden_at: 77 } as unknown as CellRowRaw
    expect(mapCellRow(raw).hidden).toBe(true)
    expect("hidden" in mapCellRow({ hidden_at: null } as unknown as CellRowRaw)).toBe(false)
  })
})
