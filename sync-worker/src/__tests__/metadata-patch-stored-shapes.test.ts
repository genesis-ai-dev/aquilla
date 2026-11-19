// `source.cell.metadata.patch` against every shape `cells.metadata` is stored in.
//
// A source link's mirror stores a cell's envelope as a double-encoded JSON
// string, not an object (`source.cell.mirror` binds the stringified envelope
// straight to the JSONB column). Reads unwrap it, so nothing notices — until a
// patch merged into one: `'"…"'::jsonb || '{}'::jsonb` is the ARRAY
// `["…", {}]`, which no reader takes for metadata.
//
// That is what "Place translations" did. Its markup-only save (the one that
// keeps a line validated) is this event with `metadata: {}` and the placed
// target HTML, so on a mirrored IDML file every line it placed lost its
// locator, and the export it was pressed for stopped on "has no supported IDML
// v2 locator" (Russian BSB, `4 JOS-EST`: 122 cells).
//
// These run on a real Postgres (PGlite) because the bug IS the engine's `||`:
// the recording stub in event-projection.test.ts could not have seen it.

import { describe, expect, it } from "vitest"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { envelopeObject } from "../events/link-envelope"
import type { AquillaStatement } from "../../../db/shim/postgres"
import type { EventPayloads } from "../events/types"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-shape"
const FILE = "file-shape-jos-est"

/** The envelope an imported IDML paragraph carries, as a mirrored BSB cell has it. */
const ENVELOPE = {
  idml: { version: 2, slotCount: 1, editableSlotIndexes: [0], protectedTokenCount: 1, anchorSequenceHash: "hash-415" },
  biblica: { version: 1, bookCode: "JDG", contentType: "notes", paragraphStyle: "ParagraphStyle/notes%3an1" },
  aquillaImport: {
    version: 1,
    profileId: "builtin:biblica-study-notes",
    milestone: { key: "biblica:JDG:6", label: "Judges 6" },
    sourceLocator: {
      kind: "idml",
      memberPath: "Stories/Story_u363.xml",
      elementPath: "/idPkg:Story[1]/Story[1]/ParagraphStyleRange[415]",
    },
  },
  idmlParagraphStyle: "ParagraphStyle/notes%3an1",
}

const SOURCE_HTML = `<p data-idml-version="2"><span data-idml-slot="0" data-idml-protected="slot">Gideon</span></p>`
const PLAIN_TARGET_HTML = "<p>Гедеон</p>"
const PLACED_TARGET_HTML = `<p data-idml-version="2"><span data-idml-slot="0" data-idml-protected="slot">Гедеон</span></p>`

/** How the row's metadata is stored. `string` is the mirror's double encoding. */
type StoredShape =
  | { as: "object"; value: Record<string, unknown> }
  | { as: "string"; text: string }
  | { as: "null" }
  | { as: "raw"; json: string }

async function seedFile(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Russian BSB', 1)`, [PROJECT])
  await t.pg.query(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
     VALUES ($1, $2, '4 JOS-EST', 'idml', 'e-file', 1000, 1000, '{}')`,
    [FILE, PROJECT],
  )
}

async function seedSource(t: TestDb, cellId: string, shape: StoredShape): Promise<void> {
  const metadataSql =
    shape.as === "string" ? "to_jsonb($5::text)" : shape.as === "null" ? "NULL::jsonb" : "$5::text::jsonb"
  const bind =
    shape.as === "string" ? shape.text
    : shape.as === "object" ? JSON.stringify(shape.value)
    : shape.as === "raw" ? shape.json
    : null
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, value_html, event_id, metadata, last_editor, last_edit_at)
     VALUES ($1, $2, $3, 'source', 'Gideon', $4, 'e-source-' || $3, ${metadataSql}, 'link-sync', 1000)`,
    shape.as === "null" ? [PROJECT, FILE, cellId, SOURCE_HTML] : [PROJECT, FILE, cellId, SOURCE_HTML, bind],
  )
}

/** A validated translation typed as plain text: what the placement finds. */
async function seedValidatedTarget(t: TestDb, cellId: string): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, value_html, event_id, source_event_id, validated, last_editor, last_edit_at)
     VALUES ($1, $2, $3, 'target', 'Гедеон', $4, 'e-target-' || $3, 'e-source-' || $3, 1, 'translator', 2000)`,
    [PROJECT, FILE, cellId, PLAIN_TARGET_HTML],
  )
}

interface StoredSource {
  stored: string | null
  text: string | null
  metadata: unknown
  value_html: string | null
  event_id: string
}

async function source(t: TestDb, cellId: string): Promise<StoredSource> {
  const res = await t.pg.query<StoredSource>(
    `SELECT jsonb_typeof(metadata) AS stored, metadata::text AS text, metadata, value_html, event_id
       FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [PROJECT, FILE, cellId],
  )
  return res.rows[0]!
}

async function target(t: TestDb, cellId: string) {
  const res = await t.pg.query<{ value: string; value_html: string; event_id: string; source_event_id: string; validated: number }>(
    `SELECT value, value_html, event_id, source_event_id, validated
       FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'`,
    [PROJECT, FILE, cellId],
  )
  return res.rows[0]!
}

let eventSeq = 0

async function applyPatch(
  t: TestDb,
  cellId: string,
  payload: Omit<EventPayloads["source.cell.metadata.patch"], "version">,
): Promise<number> {
  eventSeq += 1
  const event: PersistedEvent<"source.cell.metadata.patch"> = {
    id: `evt-patch-${eventSeq}`,
    schemaVersion: 2,
    projectId: PROJECT,
    fileId: FILE,
    cellId,
    parentId: null,
    kind: "source.cell.metadata.patch",
    author: "project-lead",
    payload: { version: 1, ...payload },
    clientTs: 3000,
    serverTs: 3000,
    serverSeq: eventSeq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  if (stmts.length > 0) await t.db.batch(stmts)
  return stmts.length
}

describe("the markup-only save of an IDML translation (an empty metadata patch)", () => {
  it("places the target HTML and leaves a link-mirrored envelope exactly as it is stored", async () => {
    const t = await makeTestDb()
    try {
      await seedFile(t)
      await seedSource(t, "cell-415", { as: "string", text: JSON.stringify(ENVELOPE) })
      await seedValidatedTarget(t, "cell-415")
      const before = await source(t, "cell-415")
      expect(before.stored).toBe("string")

      await applyPatch(t, "cell-415", { metadata: {}, targetHtml: PLACED_TARGET_HTML })

      // Byte for byte: not an array, and not quietly re-encoded either.
      const after = await source(t, "cell-415")
      expect(after).toEqual(before)
      // What every reader unwraps it to is still the whole envelope, locator included.
      expect(envelopeObject(after.metadata)).toEqual(ENVELOPE)
      // The translation: new markup; same words, same head, same pin, still validated.
      expect(await target(t, "cell-415")).toEqual({
        value: "Гедеон",
        value_html: PLACED_TARGET_HTML,
        event_id: "e-target-cell-415",
        source_event_id: "e-source-cell-415",
        validated: 1,
      })
    } finally {
      await t.close()
    }
  })

  it("leaves an object envelope and a missing one as they are too", async () => {
    const t = await makeTestDb()
    try {
      await seedFile(t)
      await seedSource(t, "cell-own", { as: "object", value: ENVELOPE })
      await seedSource(t, "cell-bare", { as: "null" })
      await seedValidatedTarget(t, "cell-own")
      await seedValidatedTarget(t, "cell-bare")
      const own = await source(t, "cell-own")
      const bare = await source(t, "cell-bare")

      await applyPatch(t, "cell-own", { metadata: {}, targetHtml: PLACED_TARGET_HTML })
      await applyPatch(t, "cell-bare", { metadata: {}, targetHtml: PLACED_TARGET_HTML })

      expect(await source(t, "cell-own")).toEqual(own)
      expect(await source(t, "cell-bare")).toEqual(bare)
      expect((await source(t, "cell-bare")).stored).toBeNull()
      expect((await target(t, "cell-own")).value_html).toBe(PLACED_TARGET_HTML)
      expect((await target(t, "cell-bare")).value_html).toBe(PLACED_TARGET_HTML)
    } finally {
      await t.close()
    }
  })

  it("writes nothing at all when it carries no HTML either", async () => {
    const t = await makeTestDb()
    try {
      await seedFile(t)
      await seedSource(t, "cell-415", { as: "string", text: JSON.stringify(ENVELOPE) })
      const before = await source(t, "cell-415")

      expect(await applyPatch(t, "cell-415", { metadata: {} })).toBe(0)

      expect(await source(t, "cell-415")).toEqual(before)
    } finally {
      await t.close()
    }
  })

  it("still replaces the protected source HTML it is sent, without touching the envelope", async () => {
    const t = await makeTestDb()
    try {
      await seedFile(t)
      await seedSource(t, "cell-415", { as: "string", text: JSON.stringify(ENVELOPE) })
      const before = await source(t, "cell-415")
      const upgraded = SOURCE_HTML.replace("Gideon", "Gideon ")

      await applyPatch(t, "cell-415", { metadata: {}, valueHtml: upgraded })

      expect(await source(t, "cell-415")).toEqual({ ...before, value_html: upgraded })
    } finally {
      await t.close()
    }
  })
})

describe("a metadata patch that carries keys", () => {
  const PATCH = { aquillaImport: { ...ENVELOPE.aquillaImport, reimportHidden: true }, cellLabel: "Gideon's call" }

  it("merges into a link-mirrored envelope as an object, not into an array around it", async () => {
    const t = await makeTestDb()
    try {
      await seedFile(t)
      await seedSource(t, "cell-415", { as: "string", text: JSON.stringify(ENVELOPE) })

      await applyPatch(t, "cell-415", { metadata: PATCH })

      const after = await source(t, "cell-415")
      expect(after.stored).toBe("object")
      expect(after.metadata).toEqual({ ...ENVELOPE, ...PATCH })
      expect(after.value_html).toBe(SOURCE_HTML)
      expect(after.event_id).toBe("e-source-cell-415")
    } finally {
      await t.close()
    }
  })

  it("merges into an object envelope and fills a missing one, as it always has", async () => {
    const t = await makeTestDb()
    try {
      await seedFile(t)
      await seedSource(t, "cell-own", { as: "object", value: ENVELOPE })
      await seedSource(t, "cell-bare", { as: "null" })

      await applyPatch(t, "cell-own", { metadata: PATCH })
      await applyPatch(t, "cell-bare", { metadata: ENVELOPE, valueHtml: SOURCE_HTML })

      expect((await source(t, "cell-own")).metadata).toEqual({ ...ENVELOPE, ...PATCH })
      const filled = await source(t, "cell-bare")
      expect(filled.stored).toBe("object")
      expect(filled.metadata).toEqual(ENVELOPE)
    } finally {
      await t.close()
    }
  })

  it("does not guess at a value it cannot read as an object, and never fails on one", async () => {
    const t = await makeTestDb()
    try {
      await seedFile(t)
      // A string that is not JSON, a string holding a JSON scalar, a string
      // that only starts like an object, and the array an earlier merge left.
      await seedSource(t, "cell-prose", { as: "string", text: "not json at all" })
      await seedSource(t, "cell-number", { as: "string", text: "42" })
      await seedSource(t, "cell-torn", { as: "string", text: '{"idml": {"version": 2' })
      await seedSource(t, "cell-array", { as: "raw", json: JSON.stringify([JSON.stringify(ENVELOPE), {}]) })

      for (const cellId of ["cell-prose", "cell-number", "cell-torn", "cell-array"]) {
        await applyPatch(t, cellId, { metadata: { cellLabel: "x" } })
      }

      // Each keeps what it held, in front of the patch: nothing is thrown away.
      expect((await source(t, "cell-prose")).metadata).toEqual(["not json at all", { cellLabel: "x" }])
      expect((await source(t, "cell-number")).metadata).toEqual(["42", { cellLabel: "x" }])
      expect((await source(t, "cell-torn")).metadata).toEqual(['{"idml": {"version": 2', { cellLabel: "x" }])
      expect((await source(t, "cell-array")).metadata).toEqual([JSON.stringify(ENVELOPE), {}, { cellLabel: "x" }])
    } finally {
      await t.close()
    }
  })
})
