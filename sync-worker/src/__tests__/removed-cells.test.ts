// AQU-1068: proving that a file's LOSSES can be recovered from the event log.
//
// The exports need this because a removed cell leaves no row — the projection
// hard-deletes it — so at export time a removal is indistinguishable from "not
// translated yet", and every native exporter re-emits the client's original
// text for a line somebody deliberately took out.
//
// The two conditions this suite exists to pin: a delete event, AND no live
// source row. Each on its own is wrong in a way that damages a real file, and
// neither failure would be visible without these tests — the export would just
// quietly keep, or quietly drop, the wrong paragraph.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { removedCellsForFile } from "../events/removed-cells"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-a"
const FILE = "file-x"

let t: TestDb

beforeAll(async () => { t = await makeTestDb() })
afterAll(async () => { await t.close() })
beforeEach(async () => { await t.reset() })

let seq = 0

async function event(kind: string, cellId: string, payload: unknown = {}): Promise<void> {
  seq += 1
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $5, 'alice', $6, 1, 1, $7)`,
    [`evt-${seq}`, PROJECT, FILE, cellId, kind, JSON.stringify(payload), seq],
  )
}

async function liveSourceRow(cellId: string): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
     VALUES ($1, $2, $3, 'source', '', 'text', 'evt-head', 1)`,
    [PROJECT, FILE, cellId],
  )
}

const created = (ref: string | null, metadata?: Record<string, unknown>) => ({
  cellId: "ignored",
  value: "some verse",
  ...(ref ? { canonicalRef: ref } : {}),
  ...(metadata ? { metadata } : {}),
})

describe("removedCellsForFile", () => {
  it("finds a cell that was created and then deleted", async () => {
    await event("source.cell.create", "c1", created("GEN 1:4"))
    await event("source.cell.delete", "c1")

    const removed = await removedCellsForFile(t.db, PROJECT, FILE)
    expect(removed).toEqual([{ cellId: "c1", canonicalRef: "GEN 1:4", metadata: null }])
  })

  it("returns nothing for a file that never lost a cell", async () => {
    await event("source.cell.create", "c1", created("GEN 1:4"))
    await liveSourceRow("c1")

    expect(await removedCellsForFile(t.db, PROJECT, FILE)).toEqual([])
  })

  it("IGNORES a delete whose cell is still there — the live row is the authority", async () => {
    // A delete is chain-arbitrated: it can be accepted, lose its AD-2 slot, and
    // apply nothing. Trusting the event alone would drop a paragraph that is
    // still in the file, which is the destructive direction of this bug.
    await event("source.cell.create", "c1", created("GEN 1:4"))
    await event("source.cell.delete", "c1")
    await liveSourceRow("c1")

    expect(await removedCellsForFile(t.db, PROJECT, FILE)).toEqual([])
  })

  it("ignores a delete that a later re-create put back", async () => {
    await event("source.cell.create", "c1", created("GEN 1:4"))
    await event("source.cell.delete", "c1")
    await event("source.cell.create", "c1", created("GEN 1:4"))
    await liveSourceRow("c1")

    expect(await removedCellsForFile(t.db, PROJECT, FILE)).toEqual([])
  })

  it("carries the package locator through for docx and pptx", async () => {
    // The metadata comes back verbatim and unparsed — reading
    // `aquillaImport.sourceLocator` out of it is the client's job.
    const metadata = {
      aquillaImport: {
        sourceLocator: { kind: "package-block", memberPath: "word/document.xml", blockPath: "w:p[7]" },
      },
    }
    await event("source.cell.create", "c1", created(null, metadata))
    await event("source.cell.delete", "c1")

    const removed = await removedCellsForFile(t.db, PROJECT, FILE)
    expect(removed).toHaveLength(1)
    expect(removed[0].canonicalRef).toBeNull()
    expect(removed[0].metadata).toEqual(metadata)
  })

  it("takes the NEWEST create when the log holds more than one", async () => {
    // An import chunk can re-send a create for the same cell id, and the bulk
    // statement dedupes last-wins — so the newest is what the projection saw.
    await event("source.cell.create", "c1", created("GEN 1:4"))
    await event("source.cell.create", "c1", created("GEN 1:5"))
    await event("source.cell.delete", "c1")

    const removed = await removedCellsForFile(t.db, PROJECT, FILE)
    expect(removed[0].canonicalRef).toBe("GEN 1:5")
  })

  it("reports a removed cell that never had a reference, with a null one", async () => {
    // A cell added in-app and then removed: it was never in the client's file,
    // so it has nothing to drop from the export. Callers filter it out by the
    // null; this function's job is to report the loss, not to judge it.
    await event("source.cell.create", "c1", created(null))
    await event("source.cell.delete", "c1")

    expect(await removedCellsForFile(t.db, PROJECT, FILE)).toEqual([
      { cellId: "c1", canonicalRef: null, metadata: null },
    ])
  })

  it("reports a deleted cell whose create is missing from the log", async () => {
    // Import-route cells land straight in `cells` with no create event. The
    // loss is still real; we just cannot say where it sat, so both locators
    // come back null and the exporters skip it.
    await event("source.cell.delete", "c1")

    expect(await removedCellsForFile(t.db, PROJECT, FILE)).toEqual([
      { cellId: "c1", canonicalRef: null, metadata: null },
    ])
  })

  it("scopes to the file — a sibling's losses are not this file's", async () => {
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ('evt-other', 1, $1, 'file-other', 'c9', 'source.cell.delete', 'alice', '{}', 1, 1, 99)`,
      [PROJECT],
    )
    await event("source.cell.create", "c1", created("GEN 1:4"))
    await event("source.cell.delete", "c1")

    const removed = await removedCellsForFile(t.db, PROJECT, FILE)
    expect(removed.map((r) => r.cellId)).toEqual(["c1"])
  })

  it("finds several losses at once", async () => {
    for (const id of ["c1", "c2", "c3"]) {
      await event("source.cell.create", id, created(`GEN 1:${id.slice(1)}`))
    }
    await event("source.cell.delete", "c1")
    await event("source.cell.delete", "c3")
    await liveSourceRow("c2")

    const removed = await removedCellsForFile(t.db, PROJECT, FILE)
    expect(removed.map((r) => r.cellId).sort()).toEqual(["c1", "c3"])
    expect(removed.map((r) => r.canonicalRef).sort()).toEqual(["GEN 1:1", "GEN 1:3"])
  })

  it("answers with an empty list rather than throwing when the read fails", async () => {
    // A failure here must never take a download with it. The worst case of an
    // empty list is today's behaviour; a throw would lose the whole export.
    const brokenDb = {
      prepare() {
        return { bind() { return { async all() { throw new Error("boom") } } } }
      },
    } as unknown as Parameters<typeof removedCellsForFile>[0]

    expect(await removedCellsForFile(brokenDb, PROJECT, FILE)).toEqual([])
  })
})
