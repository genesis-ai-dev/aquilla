// AQU-2345: the whole-project backfill behind `POST /admin/link-provenance`.
//
// Every file a source link brought in before this slice has a NULL `kind` (it
// read as `codex`) and no `file_source_blobs` row (its export 404'd). The
// repair pairs each copy with its upstream file — by the `meta.upstreamFileId`
// stamp, else by the deterministic id the live mirror gives its copies — and
// writes the upstream's type where the copy's is NULL and a pointer at the
// upstream's original. It touches no cell, no translation and no validation,
// and leaves the project's own imports alone. A file adopted under the link
// keeps its own type but, once joined, points at the upstream's original: the
// join addressed its cells to the upstream's package.

import { describe, expect, it } from "vitest"
import { deterministicDownstreamFileId } from "../events/link-sync"
import { repairAllLinkedFileProvenance, repairLinkedFileProvenance } from "../events/link-provenance"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-lp-upstream"
const DOWNSTREAM = "proj-lp-downstream"
const UP_FG = "file-up-facilitator-guide"
const UP_WB = "file-up-workbook"
const UP_COVER = "file-up-cover"
const UP_MRK = "file-up-mark"
/** A live mirror's copy: deterministic id, meta passed through verbatim. */
const MIRRORED_FG = deterministicDownstreamFileId(DOWNSTREAM, UP_FG)
/** A clone copy: fresh id, stamped. */
const CLONED_WB = "file-down-workbook"
/** A copy of a file whose upstream has no original. */
const MIRRORED_COVER = deterministicDownstreamFileId(DOWNSTREAM, UP_COVER)
/** The project's own import, which happens to be of the same material. */
const OWN_MRK = "file-own-mark"
/** The project's own file, imported before the link existed. */
const OWN_NOTES = "file-own-notes"

const FG_BLOB = { format: "idml", r2_key: `artifacts/${UPSTREAM}/art-fg/original.idml`, size_bytes: 1111 }
const WB_BLOB = { format: "idml", r2_key: `artifacts/${UPSTREAM}/art-wb/original.idml`, size_bytes: 2222 }
const MRK_UP_BLOB = { format: "usfm", r2_key: `artifacts/${UPSTREAM}/art-mrk/original.usfm`, size_bytes: 3333 }
const MRK_OWN_BLOB = { format: "usfm", r2_key: `artifacts/${DOWNSTREAM}/art-own-mrk/original.usfm`, size_bytes: 4444 }

async function seedFile(
  t: TestDb,
  projectId: string,
  id: string,
  name: string,
  cols: { kind?: string | null; bookCode?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  await t.pg.query(
    `INSERT INTO files (id, project_id, name, kind, book_code, event_id, created_at, updated_at, meta)
     VALUES ($1, $2, $3, $4, $5, $6, 1000, 1000, $7)`,
    [id, projectId, name, cols.kind ?? null, cols.bookCode ?? null, `e-${id}`, JSON.stringify(cols.meta ?? {})],
  )
}

async function seedBlob(
  t: TestDb,
  projectId: string,
  fileId: string,
  blob: { format: string; r2_key: string; size_bytes: number },
): Promise<void> {
  await t.pg.query(
    `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
     VALUES ($1, $2, $3, NULL, $4, $5, 1000)`,
    [fileId, projectId, blob.format, blob.r2_key, blob.size_bytes],
  )
}

async function seedLinkedProjects(t: TestDb, mode: "live" | "clone" = "live"): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'EBL Source Material', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor, source_link_adopt)
     VALUES ($1, 'Portuguese EBL', 1, $2, $3, 'source', 0, $4)`,
    [DOWNSTREAM, UPSTREAM, mode, JSON.stringify({ files: { [UP_MRK]: OWN_MRK }, pending: [] })],
  )
  // Upstream: three IDML files with originals, one without, and a USFM.
  await seedFile(t, UPSTREAM, UP_FG, "Facilitator Guide.idml", { kind: "idml" })
  await seedBlob(t, UPSTREAM, UP_FG, FG_BLOB)
  await seedFile(t, UPSTREAM, UP_WB, "Workbook.idml", { kind: "idml", bookCode: "WB" })
  await seedBlob(t, UPSTREAM, UP_WB, WB_BLOB)
  await seedFile(t, UPSTREAM, UP_COVER, "Cover.idml", { kind: "idml" })
  await seedFile(t, UPSTREAM, UP_MRK, "Mark.usfm", { kind: "usfm", bookCode: "MRK" })
  await seedBlob(t, UPSTREAM, UP_MRK, MRK_UP_BLOB)
  // Downstream, as the link left it: copies with no type and no original…
  await seedFile(t, DOWNSTREAM, MIRRORED_FG, "Facilitator Guide.idml", { meta: { language: "pt" } })
  await seedFile(t, DOWNSTREAM, CLONED_WB, "Workbook.idml", { meta: { upstreamFileId: UP_WB } })
  await seedFile(t, DOWNSTREAM, MIRRORED_COVER, "Cover.idml")
  // …beside the project's own files, with their own type and original.
  await seedFile(t, DOWNSTREAM, OWN_MRK, "Mark.usfm", { kind: "usfm" })
  await seedBlob(t, DOWNSTREAM, OWN_MRK, MRK_OWN_BLOB)
  await seedFile(t, DOWNSTREAM, OWN_NOTES, "Notes.md", { kind: "md" })
}

async function fileType(t: TestDb, fileId: string): Promise<{ kind: string | null; book_code: string | null }> {
  const r = await t.pg.query<{ kind: string | null; book_code: string | null }>(`SELECT kind, book_code FROM files WHERE id = $1`, [fileId])
  return r.rows[0]!
}

async function blobOf(t: TestDb, fileId: string): Promise<{ project_id: string; format: string; r2_key: string | null; size_bytes: number } | null> {
  const r = await t.pg.query<{ project_id: string; format: string; r2_key: string | null; size_bytes: string | number }>(
    `SELECT project_id, format, r2_key, size_bytes FROM file_source_blobs WHERE file_id = $1`,
    [fileId],
  )
  const row = r.rows[0]
  // BIGINT reaches the test as a string or a number depending on the driver path.
  return row ? { ...row, size_bytes: Number(row.size_bytes) } : null
}

async function snapshot(t: TestDb): Promise<{ files: unknown[]; blobs: unknown[] }> {
  const files = await t.pg.query(`SELECT id, kind, role, book_code, meta FROM files WHERE project_id = $1 ORDER BY id`, [DOWNSTREAM])
  const blobs = await t.pg.query(`SELECT * FROM file_source_blobs WHERE project_id = $1 ORDER BY file_id`, [DOWNSTREAM])
  return { files: files.rows, blobs: blobs.rows }
}

describe("repairLinkedFileProvenance (AQU-2345)", () => {
  it("gives every copy its upstream's type and a pointer at its original, points a joined file at the upstream's original, and leaves the project's own import alone", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedProjects(t)

      const report = await repairLinkedFileProvenance(t.db, DOWNSTREAM, { now: 2000 })

      expect(report).toMatchObject({
        projectId: DOWNSTREAM,
        upstreamProjectId: UPSTREAM,
        mode: "live",
        dryRun: false,
        filesPaired: 4,
        typeRepaired: 3,
        blobPointersWritten: 3,
        noUpstreamBlob: 1,
      })
      expect(report?.ownFiles).toEqual([OWN_NOTES])

      expect(await fileType(t, MIRRORED_FG)).toEqual({ kind: "idml", book_code: null })
      expect(await fileType(t, CLONED_WB)).toEqual({ kind: "idml", book_code: "WB" })
      expect(await fileType(t, MIRRORED_COVER)).toEqual({ kind: "idml", book_code: null })
      expect(await blobOf(t, MIRRORED_FG)).toEqual({ project_id: DOWNSTREAM, ...FG_BLOB })
      expect(await blobOf(t, CLONED_WB)).toEqual({ project_id: DOWNSTREAM, ...WB_BLOB })
      expect(await blobOf(t, MIRRORED_COVER)).toBeNull()
      // The adopted file keeps its own type, but its cells now describe the
      // upstream's package, so its original follows the upstream's; the own
      // import is untouched.
      expect(await fileType(t, OWN_MRK)).toEqual({ kind: "usfm", book_code: null })
      expect(await blobOf(t, OWN_MRK)).toEqual({ project_id: DOWNSTREAM, ...MRK_UP_BLOB })
      expect(await fileType(t, OWN_NOTES)).toEqual({ kind: "md", book_code: null })
      // The copy's meta is not rewritten: a mirrored row stays unstamped.
      const meta = await t.pg.query<{ meta: string }>(`SELECT meta FROM files WHERE id = $1`, [MIRRORED_FG])
      expect(JSON.parse(meta.rows[0]!.meta)).toEqual({ language: "pt" })

      // Idempotent: a second run finds nothing to do.
      expect(await repairLinkedFileProvenance(t.db, DOWNSTREAM, { now: 3000 })).toMatchObject({
        filesPaired: 4,
        typeRepaired: 0,
        blobPointersWritten: 0,
      })
    } finally {
      await t.close()
    }
  })

  it("a dry run reports the same plan and writes nothing", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedProjects(t)
      const before = await snapshot(t)

      const report = await repairLinkedFileProvenance(t.db, DOWNSTREAM, { dryRun: true })

      expect(report).toMatchObject({ dryRun: true, filesPaired: 4, typeRepaired: 3, blobPointersWritten: 3 })
      expect(await snapshot(t)).toEqual(before)
    } finally {
      await t.close()
    }
  })

  it("repairs a clone link's copies the same way", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedProjects(t, "clone")
      expect(await repairLinkedFileProvenance(t.db, DOWNSTREAM)).toMatchObject({ mode: "clone", typeRepaired: 3, blobPointersWritten: 3 })
      expect(await blobOf(t, CLONED_WB)).toMatchObject({ r2_key: WB_BLOB.r2_key })
    } finally {
      await t.close()
    }
  })

  it("reports null for a project with no source link", async () => {
    const t = await makeTestDb()
    try {
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Detached', 1)`, [DOWNSTREAM])
      expect(await repairLinkedFileProvenance(t.db, DOWNSTREAM)).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("walks every linked project and keeps going past one that fails", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedProjects(t)
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ('proj-lp-plain', 'Unlinked', 1)`)
      // A link to a project that does not exist pairs nothing but must not stop the walk.
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode) VALUES ('proj-lp-orphan', 'Orphan', 1, 'proj-lp-gone', 'live')`,
      )

      const sweep = await repairAllLinkedFileProvenance(t.db, { dryRun: true })

      expect(sweep.errors).toEqual([])
      expect(sweep.projects.map((p) => p.projectId).sort()).toEqual([DOWNSTREAM, "proj-lp-orphan"])
      expect(sweep.projects.find((p) => p.projectId === "proj-lp-orphan")).toMatchObject({ filesPaired: 0 })
    } finally {
      await t.close()
    }
  })
})
