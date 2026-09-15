// AQU-1068: the three things a USFM export needs to know about a file.
//
// Translations were always here. Additions and removals are new, and both are
// the kind of thing that fails silently: an addition that resolves to the wrong
// anchor puts the client's content under the wrong verse, and a removal that
// does not resolve at all leaves the deleted verse in the file. Neither shows
// up as an error — you get a plausible file that is wrong.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { buildUsfmExportPlan } from "../events/usfm-export-plan"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-a"
const FILE = "file-x"
const LANE = ""

let t: TestDb

beforeAll(async () => { t = await makeTestDb() })
afterAll(async () => { await t.close() })
beforeEach(async () => { await t.reset() })

let seq = 0

/** An imported verse: it has an address and no origin marker. */
async function verse(cellId: string, ref: string, anchor: string | null = null): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, canonical_ref, anchor_cell_id, event_id, last_edit_at)
     VALUES ($1, $2, $3, 'source', '', 'source text', $4, $5, $6, 1)`,
    [PROJECT, FILE, cellId, ref, anchor, `head-${cellId}`],
  )
}

/** A cell somebody added in the app: the origin marker, and no address. */
async function addedCell(cellId: string, anchor: string | null): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, canonical_ref, anchor_cell_id, metadata, event_id, last_edit_at)
     VALUES ($1, $2, $3, 'source', '', '', NULL, $4, $5, $6, 1)`,
    [PROJECT, FILE, cellId, anchor, JSON.stringify({ aquillaOrigin: { version: 1, kind: "user-insert" } }), `head-${cellId}`],
  )
}

async function translation(cellId: string, value: string, lane = LANE): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at)
     VALUES ($1, $2, $3, 'target', $4, $5, $6, 1)`,
    [PROJECT, FILE, cellId, lane, value, `tgt-${cellId}-${lane}`],
  )
}

async function deleteEvent(cellId: string, createPayload?: unknown): Promise<void> {
  if (createPayload !== undefined) {
    seq += 1
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq)
       VALUES ($1, 1, $2, $3, $4, 'source.cell.create', 'alice', $5, 1, 1, $6)`,
      [`evt-${seq}`, PROJECT, FILE, cellId, JSON.stringify(createPayload), seq],
    )
  }
  seq += 1
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, 'source.cell.delete', 'alice', '{}', 1, 1, $5)`,
    [`evt-${seq}`, PROJECT, FILE, cellId, seq],
  )
}

const plan = () => buildUsfmExportPlan(t.db, PROJECT, FILE, LANE)

describe("buildUsfmExportPlan — translations", () => {
  it("keys them by verse address", async () => {
    await verse("c4", "GEN 1:4")
    await translation("c4", "Dieu vit que la lumière était bonne.")

    const { overrides } = await plan()
    expect(overrides.get("GEN 1:4")).toBe("Dieu vit que la lumière était bonne.")
  })

  it("leaves an untranslated verse out, so it falls back to the client's words", async () => {
    await verse("c4", "GEN 1:4")
    await translation("c4", "")

    expect((await plan()).overrides.size).toBe(0)
  })

  it("reads the lane it was asked for", async () => {
    await verse("c4", "GEN 1:4")
    await translation("c4", "default lane")
    await translation("c4", "canadien", "fr-CA")

    const scoped = await buildUsfmExportPlan(t.db, PROJECT, FILE, "fr-CA")
    expect(scoped.overrides.get("GEN 1:4")).toBe("canadien")
  })
})

describe("buildUsfmExportPlan — content added in the app", () => {
  it("places an added cell under the verse it follows", async () => {
    await verse("c4", "GEN 1:4")
    await addedCell("a1", "c4")
    await translation("a1", "The line the import dropped.")

    const { edits } = await plan()
    expect(edits.appendAfter?.get("GEN 1:4")).toEqual(["The line the import dropped."])
  })

  it("leaves an UNTRANSLATED added cell out entirely", async () => {
    // Sam, 2026-09-09. The native export writes translations into the client's
    // file; an added cell with none has nothing to write, exactly like an
    // imported paragraph that nobody has translated.
    await verse("c4", "GEN 1:4")
    await addedCell("a1", "c4")

    expect((await plan()).edits.appendAfter).toBeUndefined()
  })

  it("walks a CHAIN of added cells back to the verse, in order", async () => {
    // Two cells added one after the other chain through each other: the second
    // one's anchor is the first, not the verse. One hop is the common case and
    // this is the one that catches a single-hop implementation.
    await verse("c4", "GEN 1:4")
    await addedCell("a1", "c4")
    await addedCell("a2", "a1")
    await translation("a1", "First added.")
    await translation("a2", "Second added.")

    const { edits } = await plan()
    expect(edits.appendAfter?.get("GEN 1:4")).toEqual(["First added.", "Second added."])
  })

  it("keeps additions on different verses apart", async () => {
    await verse("c4", "GEN 1:4")
    await verse("c5", "GEN 1:5", "c4")
    await addedCell("a1", "c4")
    await addedCell("a2", "c5")
    await translation("a1", "Under four.")
    await translation("a2", "Under five.")

    const { edits } = await plan()
    expect(edits.appendAfter?.get("GEN 1:4")).toEqual(["Under four."])
    expect(edits.appendAfter?.get("GEN 1:5")).toEqual(["Under five."])
  })

  it("places NOTHING for an added cell whose anchor no longer exists", async () => {
    // Rather than guessing. Putting the client's content under an arbitrary
    // verse is worse than leaving it out, and the client repairs this chain on
    // removal anyway (the successor is re-anchored onto the removed cell's own
    // anchor), so it should be rare.
    await verse("c4", "GEN 1:4")
    await addedCell("a1", "ghost-cell")
    await translation("a1", "Orphaned.")

    expect((await plan()).edits.appendAfter).toBeUndefined()
  })

  it("places nothing for an added cell at the head of the file", async () => {
    // No anchor at all means no verse to ride.
    await addedCell("a1", null)
    await translation("a1", "Before everything.")

    expect((await plan()).edits.appendAfter).toBeUndefined()
  })

  it("does not mistake an ORDINARY untranslated cell for an addition", async () => {
    // The origin marker is the only signal. Inferring "no address, so somebody
    // must have added it" would be wrong about every non-scripture import.
    await verse("c4", "GEN 1:4")
    await t.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, canonical_ref, anchor_cell_id, event_id, last_edit_at)
       VALUES ($1, $2, 'plain', 'source', '', 'text', NULL, 'c4', 'head-plain', 1)`,
      [PROJECT, FILE],
    )
    await translation("plain", "Some translation.")

    expect((await plan()).edits.appendAfter).toBeUndefined()
  })

  it("reads the addition's translation from the requested lane", async () => {
    await verse("c4", "GEN 1:4")
    await addedCell("a1", "c4")
    await translation("a1", "default", "")
    await translation("a1", "canadien", "fr-CA")

    const scoped = await buildUsfmExportPlan(t.db, PROJECT, FILE, "fr-CA")
    expect(scoped.edits.appendAfter?.get("GEN 1:4")).toEqual(["canadien"])
  })
})

describe("buildUsfmExportPlan — verses the editor removed", () => {
  it("reports a removed verse by its address", async () => {
    await verse("c5", "GEN 1:5")
    await deleteEvent("c4", { cellId: "c4", value: "gone", canonicalRef: "GEN 1:4" })

    expect([...((await plan()).edits.remove ?? [])]).toEqual(["GEN 1:4"])
  })

  it("says nothing about a verse that is still there", async () => {
    await verse("c4", "GEN 1:4")
    await deleteEvent("c4", { cellId: "c4", value: "x", canonicalRef: "GEN 1:4" })

    expect((await plan()).edits.remove).toBeUndefined()
  })

  it("ignores a removed cell that never had an address", async () => {
    // Somebody added a cell and then took it back. It was never in the client's
    // file, so there is nothing to remove from the export.
    await deleteEvent("a1", { cellId: "a1", value: "" })

    expect((await plan()).edits.remove).toBeUndefined()
  })

  it("reports several removals at once", async () => {
    await deleteEvent("c4", { cellId: "c4", value: "x", canonicalRef: "GEN 1:4" })
    await deleteEvent("c6", { cellId: "c6", value: "x", canonicalRef: "GEN 1:6" })

    expect([...((await plan()).edits.remove ?? [])].sort()).toEqual(["GEN 1:4", "GEN 1:6"])
  })
})

describe("buildUsfmExportPlan — a file nobody restructured", () => {
  it("returns no edits at all, so the serializer is byte-identical", async () => {
    await verse("c4", "GEN 1:4")
    await translation("c4", "Une traduction.")

    const { overrides, edits } = await plan()
    expect(overrides.size).toBe(1)
    expect(edits.appendAfter).toBeUndefined()
    expect(edits.remove).toBeUndefined()
  })

  it("returns an empty plan for a file with nothing in it", async () => {
    const { overrides, edits } = await plan()
    expect(overrides.size).toBe(0)
    expect(edits).toEqual({})
  })
})
