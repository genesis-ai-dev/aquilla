// AQU-2658 — the repair for the cells a metadata merge damaged before the
// projection stopped doing it (metadata-patch-stored-shapes.test.ts).
//
// It runs against production, so what it must NOT touch is tested as hard as
// what it must: the only value it may write is one the row already holds, and
// only where nothing but empty patches followed it.

import { describe, expect, it } from "vitest"
import {
  listDamagedCellMetadata,
  restoreDamagedCellMetadata,
} from "../../../db/shared/cell-metadata-repair"
import { envelopeObject } from "../events/link-envelope"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

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
