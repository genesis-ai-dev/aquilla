// AQU-2658 — the repair for the cells a metadata merge damaged before the
// projection stopped doing it (metadata-patch-stored-shapes.test.ts).
//
// It runs against production, so what it must NOT touch is tested as hard as
// what it must: the only value it may write is one the row already holds, and
// only where nothing but empty patches followed it.

import { describe, expect, it } from "vitest"
import {
  listDamagedCellMetadata,
  markProjectionRepaired,
  repairProjectCellMetadata,
  restoreDamagedCellMetadata,
} from "../../../db/shared/cell-metadata-repair"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { envelopeObject } from "../events/link-envelope"
import { makeTestToken } from "./helpers/auth"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "cell-metadata-repair-secret"

const RUSSIAN = "proj-repair-russian"
const OROMO = "proj-repair-oromo"
const JOS = "file-repair-jos-est"
const GEN = "file-repair-gen-deu"
const OROMO_JOS = "file-repair-oromo-jos-est"

function envelope(index: number): Record<string, unknown> {
  return {
    idml: { version: 2, slotCount: 1, editableSlotIndexes: [0], protectedTokenCount: 1, anchorSequenceHash: `hash-${index}` },
    aquillaImport: {
      version: 1,
      sourceLocator: {
        kind: "idml",
        memberPath: "Stories/Story_u363.xml",
        elementPath: `/idPkg:Story[1]/Story[1]/ParagraphStyleRange[${index}]`,
      },
    },
  }
}

/** The envelope as the link's mirror stores it: a JSON string. */
function mirrored(index: number): string {
  return JSON.stringify(envelope(index))
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Russian BSB', 1), ($2, 'Oromo BSB', 1)`, [RUSSIAN, OROMO])
  for (const [projectId, fileId, name] of [[RUSSIAN, JOS, "4 JOS-EST"], [RUSSIAN, GEN, "3 GEN-DEU"], [OROMO, OROMO_JOS, "4 JOS-EST"]] as const) {
    await t.pg.query(
      `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
       VALUES ($1, $2, $3, 'idml', $4, 1000, 1000, '{}')`,
      [fileId, projectId, name, `e-${fileId}`],
    )
  }
}

/** A source cell whose `metadata` is exactly this JSON text. */
async function seedSource(t: TestDb, projectId: string, fileId: string, cellId: string, metadataJson: string | null): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, metadata, last_editor, last_edit_at)
     VALUES ($1, $2, $3, 'source', 'Gideon', 'e-source-' || $3, $4::text::jsonb, 'link-sync', 1000)`,
    [projectId, fileId, cellId, metadataJson],
  )
}

/** What an empty patch left: the mirrored string, then `{}` once per patch. */
function damagedBy(emptyPatches: number, index: number): string {
  return JSON.stringify([mirrored(index), ...Array.from({ length: emptyPatches }, () => ({}))])
}

async function stored(t: TestDb, projectId: string, fileId: string): Promise<Record<string, { shape: string | null; text: string | null; metadata: unknown }>> {
  const res = await t.pg.query<{ cell_id: string; shape: string | null; text: string | null; metadata: unknown }>(
    `SELECT cell_id, jsonb_typeof(metadata) AS shape, metadata::text AS text, metadata
       FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'source'`,
    [projectId, fileId],
  )
  return Object.fromEntries(res.rows.map((row) => [row.cell_id, { shape: row.shape, text: row.text, metadata: row.metadata }]))
}

describe("finding the cells a metadata merge damaged", () => {
  it("reports each file's arrays and how many of them can be put back", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedSource(t, RUSSIAN, JOS, "cell-1", damagedBy(1, 1))
      await seedSource(t, RUSSIAN, JOS, "cell-2", damagedBy(1, 2))
      // A patch that carried keys: an array, but not one to put back blind.
      await seedSource(t, RUSSIAN, JOS, "cell-3", JSON.stringify([mirrored(3), { cellLabel: "Gideon's call" }]))
      // Never touched: a mirrored string, an own import's object, no envelope.
      await seedSource(t, RUSSIAN, JOS, "cell-4", JSON.stringify(mirrored(4)))
      await seedSource(t, RUSSIAN, GEN, "cell-5", JSON.stringify(envelope(5)))
      await seedSource(t, RUSSIAN, GEN, "cell-6", null)
      await seedSource(t, OROMO, OROMO_JOS, "cell-1", damagedBy(1, 1))

      expect(await listDamagedCellMetadata(t.db)).toEqual([
        { projectId: OROMO, projectName: "Oromo BSB", fileId: OROMO_JOS, fileName: "4 JOS-EST", damaged: 1, restorable: 1 },
        { projectId: RUSSIAN, projectName: "Russian BSB", fileId: JOS, fileName: "4 JOS-EST", damaged: 3, restorable: 2 },
      ])
      // One project at a time, which is how production is read.
      expect((await listDamagedCellMetadata(t.db, { projectId: OROMO })).map((file) => file.fileId)).toEqual([OROMO_JOS])
      expect(await listDamagedCellMetadata(t.db, { projectId: "proj-no-such" })).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("is quiet on a database nothing damaged", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedSource(t, RUSSIAN, JOS, "cell-1", JSON.stringify(mirrored(1)))
      await seedSource(t, RUSSIAN, GEN, "cell-2", JSON.stringify(envelope(2)))

      expect(await listDamagedCellMetadata(t.db)).toEqual([])
      expect(await restoreDamagedCellMetadata(t.db, RUSSIAN, JOS)).toBe(0)
    } finally {
      await t.close()
    }
  })
})

describe("putting them back", () => {
  it("restores each cell to exactly the value it held before the merge", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedSource(t, RUSSIAN, JOS, "cell-1", damagedBy(1, 1))
      // Placed twice: two empty patches behind the same envelope.
      await seedSource(t, RUSSIAN, JOS, "cell-2", damagedBy(2, 2))
      // The neighbour the merge never reached, for comparison.
      await seedSource(t, RUSSIAN, JOS, "cell-3", JSON.stringify(mirrored(3)))

      expect(await restoreDamagedCellMetadata(t.db, RUSSIAN, JOS)).toBe(2)

      const after = await stored(t, RUSSIAN, JOS)
      for (const [cellId, index] of [["cell-1", 1], ["cell-2", 2], ["cell-3", 3]] as const) {
        // A JSON string again, the same text the mirror wrote...
        expect(after[cellId]).toMatchObject({ shape: "string", text: JSON.stringify(mirrored(index)) })
        // ...which every reader unwraps to the whole envelope, locator included.
        expect(envelopeObject(after[cellId]!.metadata)).toEqual(envelope(index))
      }
      expect(await listDamagedCellMetadata(t.db)).toEqual([])
      // A second apply has nothing to do.
      expect(await restoreDamagedCellMetadata(t.db, RUSSIAN, JOS)).toBe(0)
    } finally {
      await t.close()
    }
  })

  it("leaves every array that is not an empty patch's, and everything that is not an array", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      const untouched: Record<string, string | null> = {
        // A patch that added something: putting the first element back would lose it.
        "keyed-patch": JSON.stringify([mirrored(1), { cellLabel: "Gideon's call" }]),
        "keyed-then-empty": JSON.stringify([mirrored(2), { cast_name: "Narrator" }, {}]),
        // A first element that is not a string-encoded object.
        "object-first": JSON.stringify([envelope(3), {}]),
        "prose-first": JSON.stringify(["not json at all", {}]),
        "torn-first": JSON.stringify(['{"idml": {"version": 2', {}]),
        "scalar-first": JSON.stringify(["42", {}]),
        // Not followed by a patch at all.
        "lone-string": JSON.stringify([mirrored(4)]),
        "string-then-string": JSON.stringify([mirrored(5), "x"]),
        "empty-array": "[]",
        // Not arrays.
        "mirrored": JSON.stringify(mirrored(6)),
        "own-import": JSON.stringify(envelope(7)),
        "empty-object": "{}",
        "no-envelope": null,
      }
      for (const [cellId, json] of Object.entries(untouched)) await seedSource(t, RUSSIAN, JOS, cellId, json)
      // The one cell in the file that IS the damage.
      await seedSource(t, RUSSIAN, JOS, "damaged", damagedBy(1, 8))
      const before = await stored(t, RUSSIAN, JOS)

      expect(await restoreDamagedCellMetadata(t.db, RUSSIAN, JOS)).toBe(1)

      const after = await stored(t, RUSSIAN, JOS)
      for (const cellId of Object.keys(untouched)) expect(after[cellId], cellId).toEqual(before[cellId])
      expect(after.damaged).toMatchObject({ shape: "string", text: JSON.stringify(mirrored(8)) })
      // The arrays it would not touch are still reported, so a person sees them.
      expect(await listDamagedCellMetadata(t.db)).toEqual([
        { projectId: RUSSIAN, projectName: "Russian BSB", fileId: JOS, fileName: "4 JOS-EST", damaged: 9, restorable: 0 },
      ])
    } finally {
      await t.close()
    }
  })

  it("writes only the file it was given, and never a translation", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedSource(t, RUSSIAN, JOS, "cell-1", damagedBy(1, 1))
      await seedSource(t, RUSSIAN, GEN, "cell-1", damagedBy(1, 1))
      await seedSource(t, OROMO, OROMO_JOS, "cell-1", damagedBy(1, 1))
      await t.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, value_html, event_id, source_event_id, validated, last_editor, last_edit_at)
         VALUES ($1, $2, 'cell-1', 'target', 'Гедеон', '<p>Гедеон</p>', 'e-target-1', 'e-source-cell-1', 1, 'translator', 2000)`,
        [RUSSIAN, JOS],
      )
      const targetBefore = await t.pg.query(`SELECT * FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'target'`, [RUSSIAN, JOS])
      const sourceBefore = await t.pg.query(`SELECT value, value_html, event_id, last_editor, last_edit_at FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'source'`, [RUSSIAN, JOS])

      expect(await restoreDamagedCellMetadata(t.db, RUSSIAN, JOS)).toBe(1)

      expect((await stored(t, RUSSIAN, JOS))["cell-1"]!.shape).toBe("string")
      expect((await stored(t, RUSSIAN, GEN))["cell-1"]!.shape).toBe("array")
      expect((await stored(t, OROMO, OROMO_JOS))["cell-1"]!.shape).toBe("array")
      // The translation, and everything about the source but its metadata.
      expect((await t.pg.query(`SELECT * FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'target'`, [RUSSIAN, JOS])).rows).toEqual(targetBefore.rows)
      expect((await t.pg.query(`SELECT value, value_html, event_id, last_editor, last_edit_at FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'source'`, [RUSSIAN, JOS])).rows).toEqual(sourceBefore.rows)
    } finally {
      await t.close()
    }
  })
})

// A browser keeps each file's cells in IndexedDB with the file's event-log
// watermark, and on reopen asks only for what changed since. Putting a row
// back mints no event. Production's first repair (2026-11-20) restored 51
// cells and the export went on failing on every one of them, in a browser
// that had the file cached: the rows were right and nothing said so.
describe("a browser that cached the damaged cells", () => {
  const LAST_EVENT_SEQ = 7

  /** One damaged cell, and the mirror event that is the file's newest. */
  async function seedDamagedFile(t: TestDb): Promise<void> {
    await seedProjects(t)
    await seedSource(t, RUSSIAN, JOS, "cell-1", damagedBy(1, 1))
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
       VALUES ('e-mirror-1', 1, $1, $2, 'cell-1', 'source.cell.mirror', 'link-sync', '{}', 1000, 1000, NULL, $3)`,
      [RUSSIAN, JOS, LAST_EVENT_SEQ],
    )
  }

  async function read(t: TestDb, query: string) {
    const token = await makeTestToken(SECRET, { projectId: RUSSIAN, fileId: JOS })
    const res = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/${RUSSIAN}/files/${JOS}/cells?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET },
    ))!
    expect(res.status).toBe(200)
    return (await res.json()) as {
      delta?: boolean
      resync?: boolean
      changedCellIds?: string[]
      maxServerSeq: number
      cells?: Array<{ cellId: string; metadata: unknown }>
    }
  }

  async function marker(t: TestDb, projectId: string): Promise<number | null> {
    const res = await t.pg.query<{ rebuilt_seq: number | null }>(
      `SELECT rebuilt_seq FROM project_seq_counters WHERE project_id = $1`,
      [projectId],
    )
    return res.rows[0]?.rebuilt_seq ?? null
  }

  it("is told to read the file again, and reads the repaired cell", async () => {
    const t = await makeTestDb()
    try {
      await seedDamagedFile(t)
      // Warm and caught up: nothing newer than what it holds.
      expect(await read(t, `since=${LAST_EVENT_SEQ}`)).toMatchObject({ delta: true, changedCellIds: [] })

      const repaired = await repairProjectCellMetadata(t.db, RUSSIAN, [JOS])

      expect(repaired).toMatchObject({ restored: 1, restoredByFile: { [JOS]: 1 } })
      expect(repaired.resyncMarker).toBeGreaterThan(LAST_EVENT_SEQ)
      // The same cursor is now answered with a resync, not an empty delta.
      const after = await read(t, `since=${LAST_EVENT_SEQ}`)
      expect(after.resync).toBe(true)
      expect(after.delta).toBeUndefined()
      // The full read it falls back to carries the envelope, locator and all...
      const full = await read(t, "side=source")
      expect(full.cells).toHaveLength(1)
      expect(full.cells![0]!.metadata).toEqual(envelope(1))
      // ...and a cursor past the marker, so the next delta is an ordinary one.
      expect(await read(t, `since=${full.maxServerSeq}`)).toMatchObject({ delta: true, changedCellIds: [] })
    } finally {
      await t.close()
    }
  })

  it("goes on showing them when the rows are put back and nothing says so, until --resync does", async () => {
    const t = await makeTestDb()
    try {
      await seedDamagedFile(t)

      // What the first production repair did: the rows, and only the rows.
      expect(await restoreDamagedCellMetadata(t.db, RUSSIAN, JOS)).toBe(1)
      expect(await listDamagedCellMetadata(t.db)).toEqual([])
      expect(await read(t, `since=${LAST_EVENT_SEQ}`)).toMatchObject({ delta: true, changedCellIds: [] })

      // Nothing left to put back, so a plain apply has no reason to move the marker...
      expect(await repairProjectCellMetadata(t.db, RUSSIAN, [JOS])).toEqual({
        restoredByFile: { [JOS]: 0 }, restored: 0, resyncMarker: null,
      })
      expect(await marker(t, RUSSIAN)).toBeNull()
      expect((await read(t, `since=${LAST_EVENT_SEQ}`)).delta).toBe(true)

      // ...and --resync does it for the project named, with no file to repair.
      const resynced = await repairProjectCellMetadata(t.db, RUSSIAN, [], { resync: true })
      expect(resynced).toMatchObject({ restored: 0, restoredByFile: {} })
      expect(resynced.resyncMarker).toBeGreaterThan(LAST_EVENT_SEQ)
      expect((await read(t, `since=${LAST_EVENT_SEQ}`)).resync).toBe(true)
      // Only that project: its neighbour's clients are not sent round again.
      expect(await marker(t, OROMO)).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("moves the marker above every cursor a client could hold, every time", async () => {
    const t = await makeTestDb()
    try {
      await seedDamagedFile(t)

      const first = await markProjectionRepaired(t.db, RUSSIAN)
      const second = await markProjectionRepaired(t.db, RUSSIAN)

      expect(first).toBe(LAST_EVENT_SEQ + 1)
      expect(second).toBe(first + 1)
      expect(await marker(t, RUSSIAN)).toBe(second)
      // A project with no events yet still gets a marker a cursor of 0 trips.
      expect(await markProjectionRepaired(t.db, OROMO)).toBe(1)
    } finally {
      await t.close()
    }
  })

  it("leaves the cells and the marker as they were when the repair cannot finish", async () => {
    const t = await makeTestDb()
    try {
      await seedDamagedFile(t)
      const before = await stored(t, RUSSIAN, JOS)
      // The marker statement fails: the counter row cannot take the next seq.
      await t.pg.query(`ALTER TABLE project_seq_counters ADD CONSTRAINT no_marker_for_this_test CHECK (rebuilt_seq = 0)`)

      await expect(repairProjectCellMetadata(t.db, RUSSIAN, [JOS])).rejects.toThrow()

      // Rows and marker go together or not at all: a repair that restored the
      // cells and then failed to announce it is the bug this exists to prevent.
      expect(await stored(t, RUSSIAN, JOS)).toEqual(before)
      expect(await marker(t, RUSSIAN)).toBeNull()
    } finally {
      await t.close()
    }
  })
})
