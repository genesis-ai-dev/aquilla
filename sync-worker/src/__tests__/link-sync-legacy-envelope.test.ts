// A file a source link mirrored before the link carried the import envelope
// (AQU-1520, 2026-10-01) holds source cells whose `metadata` is NULL. Since
// AQU-2345 such a file reads as IDML and offers the InDesign download, and the
// exporter stops on its first cell: "has no supported IDML v2 locator". Every
// EBL language project (linked 2026-09-22) was in that state, and no fold would
// ever fix it — the upstream is finished, so there is nothing to mirror.
//
// Every link sync now gives those cells the upstream's envelope, as a
// `source.cell.metadata.patch` that leaves the source's `event_id` — and so
// every translation's staleness pin and validation — exactly where it was.

import { describe, expect, it } from "vitest"
import { deterministicDownstreamFileId, mirrorSync } from "../events/link-sync"
import { ENVELOPE_REPAIR_CELLS, envelopeObject, repairMirroredCellEnvelopes } from "../events/link-envelope"
import { repairLinkedFileProvenance } from "../events/link-provenance"
import { syncUntilCaughtUp } from "../events/link-sync-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-env-upstream"
const DOWNSTREAM = "proj-env-downstream"
const UP_FILE = "file-env-facilitator-guide"
const DOWN_FILE = deterministicDownstreamFileId(DOWNSTREAM, UP_FILE)
/** The project's own import: never paired, never touched. */
const OWN_FILE = "file-env-own"

/** The envelope an imported IDML paragraph carries. */
function envelope(index: number): Record<string, unknown> {
  return {
    idml: { version: 2, slotCount: 1, editableSlotIndexes: [0], protectedTokenCount: 0, anchorSequenceHash: `hash-${index}` },
    aquillaImport: {
      version: 1,
      profileId: "builtin:biblica-ebl",
      sourceLocator: {
        kind: "idml",
        memberPath: "Stories/Story_u3f09.xml",
        elementPath: `/idPkg:Story[1]/Story[1]/ParagraphStyleRange[${index}]`,
      },
    },
  }
}

function protectedHtml(text: string): string {
  return `<p data-idml-version="2"><span data-idml-slot="0" data-idml-protected="slot">${text}</span></p>`
}

async function seedProjects(t: TestDb, consumes: "source" | "target" = "source"): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'EBL Source Material', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'Russian EBL', 1, $2, 'live', $3, 0)`,
    [DOWNSTREAM, UPSTREAM, consumes],
  )
  for (const [projectId, fileId] of [[UPSTREAM, UP_FILE], [DOWNSTREAM, DOWN_FILE], [DOWNSTREAM, OWN_FILE]] as const) {
    await t.pg.query(
      `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
       VALUES ($1, $2, 'Facilitator Guide', 'idml', $3, 1000, 1000, '{}')`,
      [fileId, projectId, `e-${fileId}`],
    )
  }
}

interface SeedCell {
  projectId: string
  fileId: string
  cellId: string
  side?: "source" | "target"
  value: string
  valueHtml?: string | null
  metadata?: Record<string, unknown> | null
  eventId?: string
  sourceEventId?: string | null
  tombstoned?: boolean
}

async function seedCell(t: TestDb, cell: SeedCell): Promise<void> {
  await t.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, value_html, event_id, source_event_id, metadata, tombstoned_at, last_editor, last_edit_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'seed', 1000)`,
    [
      cell.projectId,
      cell.fileId,
      cell.cellId,
      cell.side ?? "source",
      cell.value,
      cell.valueHtml ?? null,
      cell.eventId ?? `e-${cell.projectId}-${cell.cellId}-${cell.side ?? "source"}`,
      cell.sourceEventId ?? null,
      cell.metadata ? JSON.stringify(cell.metadata) : null,
      cell.tombstoned ? 2000 : null,
    ],
  )
}

/** Upstream cell `n` with its envelope, and the downstream copy without one. */
async function seedMirroredPair(t: TestDb, n: number, text = `Paragraph ${n}`): Promise<void> {
  await seedCell(t, {
    projectId: UPSTREAM, fileId: UP_FILE, cellId: `cell-${n}`,
    value: text, valueHtml: protectedHtml(text), metadata: envelope(n),
  })
  await seedCell(t, {
    projectId: DOWNSTREAM, fileId: DOWN_FILE, cellId: `cell-${n}`,
    value: text, valueHtml: protectedHtml(text), metadata: null,
  })
}

async function sourceCell(t: TestDb, projectId: string, fileId: string, cellId: string) {
  const res = await t.pg.query<{ metadata: unknown; value_html: string | null; event_id: string }>(
    `SELECT metadata, value_html, event_id FROM cells
      WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [projectId, fileId, cellId],
  )
  return res.rows[0]
}

async function patchEvents(t: TestDb) {
  const res = await t.pg.query<{ id: string; cell_id: string; schema_version: number; author: string; payload: unknown }>(
    `SELECT id, cell_id, schema_version, author, payload FROM events
      WHERE project_id = $1 AND kind = 'source.cell.metadata.patch' ORDER BY server_seq`,
    [DOWNSTREAM],
  )
  return res.rows.map((row) => ({
    ...row,
    payload: (typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as {
      version: number
      metadata: Record<string, unknown>
      valueHtml?: string
    },
  }))
}

describe("a link sync gives pre-AQU-1520 copies their import envelope", () => {
  it("fills the envelope from the upstream cell on a sync that has nothing else to do", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedMirroredPair(t, 1)
      await seedMirroredPair(t, 2)

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result).toMatchObject({ ranSync: true, envelopesRepaired: 2, cellsMirrored: 0, more: false })
      expect(envelopeObject((await sourceCell(t, DOWNSTREAM, DOWN_FILE, "cell-1")).metadata)).toEqual(envelope(1))
      expect(envelopeObject((await sourceCell(t, DOWNSTREAM, DOWN_FILE, "cell-2")).metadata)).toEqual(envelope(2))
      const events = await patchEvents(t)
      expect(events.map((event) => event.cell_id)).toEqual(["cell-1", "cell-2"])
      expect(events[0]).toMatchObject({ schema_version: 2, author: "link-sync", payload: { version: 1, metadata: envelope(1) } })
      // The copy already holds the upstream's protected HTML: nothing to resend.
      expect(events[0]!.payload.valueHtml).toBeUndefined()
    } finally {
      await t.close()
    }
  })

  it("leaves the source's event id, the translation and its pin alone", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedMirroredPair(t, 1)
      const before = await sourceCell(t, DOWNSTREAM, DOWN_FILE, "cell-1")
      await seedCell(t, {
        projectId: DOWNSTREAM, fileId: DOWN_FILE, cellId: "cell-1", side: "target",
        value: "Абзац 1", valueHtml: "<p>Абзац 1</p>", eventId: "e-target-1", sourceEventId: before.event_id,
      })

      await mirrorSync(t.db, DOWNSTREAM)

      expect((await sourceCell(t, DOWNSTREAM, DOWN_FILE, "cell-1")).event_id).toBe(before.event_id)
      const target = await t.pg.query<{ value: string; value_html: string; event_id: string; source_event_id: string }>(
        `SELECT value, value_html, event_id, source_event_id FROM cells
          WHERE project_id = $1 AND file_id = $2 AND cell_id = 'cell-1' AND side = 'target'`,
        [DOWNSTREAM, DOWN_FILE],
      )
      expect(target.rows[0]).toEqual({
        value: "Абзац 1", value_html: "<p>Абзац 1</p>", event_id: "e-target-1", source_event_id: before.event_id,
      })
    } finally {
      await t.close()
    }
  })

  it("is a no-op once repaired, and never overwrites an envelope a cell already has", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedMirroredPair(t, 1)
      const own = { aquillaImport: { milestone: { label: "kept" } } }
      await seedCell(t, { projectId: UPSTREAM, fileId: UP_FILE, cellId: "cell-2", value: "Two", metadata: envelope(2) })
      await seedCell(t, { projectId: DOWNSTREAM, fileId: DOWN_FILE, cellId: "cell-2", value: "Two", metadata: own })

      expect((await mirrorSync(t.db, DOWNSTREAM)).envelopesRepaired).toBe(1)
      const second = await mirrorSync(t.db, DOWNSTREAM)

      expect(second.ranSync).toBe(false)
      expect(second.envelopesRepaired).toBeUndefined()
      expect((await patchEvents(t)).map((event) => event.cell_id)).toEqual(["cell-1"])
      expect(envelopeObject((await sourceCell(t, DOWNSTREAM, DOWN_FILE, "cell-2")).metadata)).toEqual(own)
    } finally {
      await t.close()
    }
  })

  it("skips a cell whose text is not the upstream's, a tombstone, and the project's own file", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      // Behind on its text: the upstream's envelope describes a paragraph this
      // copy does not hold yet.
      await seedCell(t, { projectId: UPSTREAM, fileId: UP_FILE, cellId: "cell-1", value: "New wording", metadata: envelope(1) })
      await seedCell(t, { projectId: DOWNSTREAM, fileId: DOWN_FILE, cellId: "cell-1", value: "Old wording" })
      // Removed downstream.
      await seedCell(t, { projectId: UPSTREAM, fileId: UP_FILE, cellId: "cell-2", value: "Two", metadata: envelope(2) })
      await seedCell(t, { projectId: DOWNSTREAM, fileId: DOWN_FILE, cellId: "cell-2", value: "Two", tombstoned: true })
      // Same cell id and text, in a file the link never made.
      await seedCell(t, { projectId: UPSTREAM, fileId: UP_FILE, cellId: "cell-3", value: "Three", metadata: envelope(3) })
      await seedCell(t, { projectId: DOWNSTREAM, fileId: OWN_FILE, cellId: "cell-3", value: "Three" })
      // The upstream has no envelope either: a file that never had divisions.
      await seedCell(t, { projectId: UPSTREAM, fileId: UP_FILE, cellId: "cell-4", value: "Four" })
      await seedCell(t, { projectId: DOWNSTREAM, fileId: DOWN_FILE, cellId: "cell-4", value: "Four" })

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.envelopesRepaired).toBeUndefined()
      expect(await patchEvents(t)).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("sends the upstream's protected HTML with the envelope when the copy's differs", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedCell(t, {
        projectId: UPSTREAM, fileId: UP_FILE, cellId: "cell-1",
        value: "Paragraph", valueHtml: protectedHtml("Paragraph"), metadata: envelope(1),
      })
      await seedCell(t, {
        projectId: DOWNSTREAM, fileId: DOWN_FILE, cellId: "cell-1", value: "Paragraph", valueHtml: "<p>Paragraph</p>",
      })

      await mirrorSync(t.db, DOWNSTREAM)

      expect((await patchEvents(t))[0]!.payload.valueHtml).toBe(protectedHtml("Paragraph"))
      expect((await sourceCell(t, DOWNSTREAM, DOWN_FILE, "cell-1")).value_html).toBe(protectedHtml("Paragraph"))
    } finally {
      await t.close()
    }
  })

  it("does not touch a link that consumes the upstream's target", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t, "target")
      await seedMirroredPair(t, 1)

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.envelopesRepaired).toBeUndefined()
      expect(await patchEvents(t)).toEqual([])
    } finally {
      await t.close()
    }
  })

  it("repairs a large file over several calls, which the route chains", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      for (let n = 1; n <= 5; n++) await seedMirroredPair(t, n)
      const pairs = [{ upstreamFileId: UP_FILE, downstreamFileId: DOWN_FILE }]
      const args = {
        upstreamProjectId: UPSTREAM, downstreamProjectId: DOWNSTREAM, pairs,
        eventId: (key: string) => `evt-${key}`, author: "link-sync", now: 5000,
      }

      expect(await repairMirroredCellEnvelopes(t.db, { ...args, dryRun: true })).toEqual({ repaired: 5, more: false })
      expect(await patchEvents(t)).toEqual([])
      expect(await repairMirroredCellEnvelopes(t.db, { ...args, limit: 2 })).toEqual({ repaired: 2, more: true })
      expect(await repairMirroredCellEnvelopes(t.db, { ...args, limit: 2 })).toEqual({ repaired: 2, more: true })
      expect(await repairMirroredCellEnvelopes(t.db, { ...args, limit: 2 })).toEqual({ repaired: 1, more: false })
      expect(await patchEvents(t)).toHaveLength(5)
      expect(ENVELOPE_REPAIR_CELLS).toBeGreaterThan(0)

      // The route's loop adds the rounds up.
      const rounds = [
        { ranSync: true, cellsMirrored: 0, filesMirrored: 0, fromSeq: 7, toSeq: 7, skippedHashEqual: 0, windows: 0, more: true, envelopesRepaired: 1000 },
        { ranSync: true, cellsMirrored: 0, filesMirrored: 0, fromSeq: 7, toSeq: 7, skippedHashEqual: 0, windows: 0, more: false, envelopesRepaired: 32 },
      ]
      const total = await syncUntilCaughtUp(async () => rounds.shift()!)
      expect(total).toMatchObject({ envelopesRepaired: 1032, more: false, toSeq: 7 })
    } finally {
      await t.close()
    }
  })

  it("runs from the admin backfill, dry first", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedMirroredPair(t, 1)
      await seedMirroredPair(t, 2)

      expect(await repairLinkedFileProvenance(t.db, DOWNSTREAM, { dryRun: true })).toMatchObject({ envelopesRepaired: 2 })
      expect(await patchEvents(t)).toEqual([])
      expect(await repairLinkedFileProvenance(t.db, DOWNSTREAM)).toMatchObject({ envelopesRepaired: 2 })
      expect(await patchEvents(t)).toHaveLength(2)
      expect(await repairLinkedFileProvenance(t.db, DOWNSTREAM)).toMatchObject({ envelopesRepaired: 0 })
    } finally {
      await t.close()
    }
  })
})
