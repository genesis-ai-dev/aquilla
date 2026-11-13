// AQU-2345: a file linked in from a source project can still be exported.
//
// The mirror carried the upstream's `files` row and its cells and left the
// `file_source_blobs` side-car behind — the one row the export route resolves
// original bytes through, and the only thing `hasOriginalSource` is read off.
// So every IDML file linked from a source project into a language project
// reported `hasOriginalSource: false` and 404'd on export with "no source blob
// recorded for this file — re-import to enable export": all four files of each
// EBL language project, and every BSB batch except the one imported into the
// language project directly from IDML. Re-importing would have been the only
// repair, and it would have wiped the translations it was repairing export for.
//
// The mirror now points the downstream row at the upstream row's R2 object —
// one pointer per file, no bytes copied, both projects reading the same
// `aquilla-snapshots` object. The sweep runs before a sync can decide it has
// nothing to do, so a project whose link ALREADY ran is backfilled by its next
// sync rather than needing a migration.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { handleExportSourceRequest } from "../events/export-route"
import type { AquillaStatement, AquillaDb } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const UPSTREAM = "proj-ebl-source-material"
const DOWNSTREAM = "proj-ebl-portuguese"
const FILE = "file-facilitator-guide"
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)
const R2_KEY = `artifacts/${UPSTREAM}/facilitator-guide.idml`
// A zip magic number is enough: the export route serves IDML bytes verbatim.
const IDML_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00])
const SECRET = "test-secret"

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-blob-${_seq}`
}

function makeStubBucket(objects: Record<string, Uint8Array>) {
  return {
    async get(key: string) {
      const body = objects[key]
      if (!body) return null
      return {
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      }
    },
  }
}

function makeEnv(db: AquillaDb, objects: Record<string, Uint8Array> = { [R2_KEY]: IDML_BYTES }) {
  return {
    AQUILLA_PG: db,
    SYNC_SECRET_KEY: SECRET,
    SNAPSHOTS: makeStubBucket(objects) as unknown as R2Bucket,
  }
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'EBL Source Material', 1)`, [
    UPSTREAM,
  ])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'Portuguese EBL', 1, $2, 'live', 'source', 0)`,
    [DOWNSTREAM, UPSTREAM],
  )
}

async function emitUpstream(
  t: TestDb,
  kind: "file.create" | "source.cell.create",
  args: { fileId: string; cellId?: string; payload: Record<string, unknown> },
): Promise<void> {
  const id = nextId()
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  const seq = Number(seqRow.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'lead', $6, 1, $7, $8)`,
    [id, UPSTREAM, args.fileId, args.cellId ?? null, kind, JSON.stringify(args.payload), seq, seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId,
    cellId: args.cellId ?? null,
    parentId: null,
    kind,
    author: "lead",
    payload: args.payload,
    clientTs: 1,
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

/** The upstream project as it really is: an IDML import, bytes in R2. */
async function seedUpstreamIdmlFile(t: TestDb): Promise<void> {
  await emitUpstream(t, "file.create", {
    fileId: FILE,
    payload: { name: "Facilitator Guide", fileType: "idml" },
  })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "Stories/Story_u1a.xml#1",
    payload: { cellId: "Stories/Story_u1a.xml#1", value: "Welcome", anchorCellId: null },
  })
  await t.pg.query(
    `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
     VALUES ($1, $2, 'idml', NULL, $3, $4, 1)`,
    [FILE, UPSTREAM, R2_KEY, IDML_BYTES.byteLength],
  )
}

interface BlobRow {
  file_id: string
  project_id: string
  format: string
  raw_source: string | null
  r2_key: string | null
  size_bytes: string | number | null
}

async function blobRows(t: TestDb, projectId: string): Promise<BlobRow[]> {
  const r = await t.pg.query<BlobRow>(
    `SELECT file_id, project_id, format, raw_source, r2_key, size_bytes
       FROM file_source_blobs WHERE project_id = $1 ORDER BY file_id`,
    [projectId],
  )
  return r.rows
}

async function exportDownstream(db: AquillaDb, fileId = DOWNSTREAM_FILE): Promise<Response> {
  const token = await makeTestToken(SECRET, { projectId: DOWNSTREAM, fileId, role: 600 })
  const res = await handleExportSourceRequest(
    new Request(`https://w/api/v1/projects/${DOWNSTREAM}/files/${fileId}/source`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    makeEnv(db),
  )
  expect(res).not.toBeNull()
  return res!
}

describe("mirrorSync — a linked file keeps its original artifact (AQU-2345)", () => {
  it("points the downstream side-car at the upstream's R2 object, copying no bytes", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamIdmlFile(t)

      expect((await mirrorSync(t.db, DOWNSTREAM)).filesMirrored).toBe(1)

      const rows = await blobRows(t, DOWNSTREAM)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        file_id: DOWNSTREAM_FILE,
        project_id: DOWNSTREAM,
        format: "idml",
        // The pointer, not a copy: same key the upstream's own export reads.
        r2_key: R2_KEY,
        raw_source: null,
      })
      expect(Number(rows[0].size_bytes)).toBe(IDML_BYTES.byteLength)
      // The upstream is untouched.
      expect(await blobRows(t, UPSTREAM)).toHaveLength(1)
    } finally {
      await t.close()
    }
  })

  it("ends the regression: export serves the IDML instead of 404 no-source-blob", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamIdmlFile(t)
      await mirrorSync(t.db, DOWNSTREAM)

      const res = await exportDownstream(t.db)

      expect(res.status).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(IDML_BYTES)
    } finally {
      await t.close()
    }
  })

  it("backfills a project whose link already ran — the next sync has nothing to mirror and still repairs it", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamIdmlFile(t)
      await mirrorSync(t.db, DOWNSTREAM)
      // The 26 production files: linked before the fix existed, so the row the
      // mirror would write today is simply absent. Nothing new upstream, so
      // this sync folds no window at all.
      await t.pg.query(`DELETE FROM file_source_blobs WHERE project_id = $1`, [DOWNSTREAM])
      expect((await exportDownstream(t.db)).status).toBe(404)

      const second = await mirrorSync(t.db, DOWNSTREAM)

      expect(second.filesMirrored).toBe(0)
      expect(second.cellsMirrored).toBe(0)
      expect(await blobRows(t, DOWNSTREAM)).toHaveLength(1)
      expect((await exportDownstream(t.db)).status).toBe(200)
    } finally {
      await t.close()
    }
  })

  it("matches by the deterministic mirror id when the row carries no provenance stamp", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamIdmlFile(t)
      await mirrorSync(t.db, DOWNSTREAM)
      // Mirrored before AQU-1547 stamped `meta.upstreamFileId`: identity then
      // rests entirely on the derived file id.
      await t.pg.query(`UPDATE files SET meta = '{}' WHERE id = $1`, [DOWNSTREAM_FILE])
      await t.pg.query(`DELETE FROM file_source_blobs WHERE project_id = $1`, [DOWNSTREAM])

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await blobRows(t, DOWNSTREAM)).toMatchObject([{ r2_key: R2_KEY, format: "idml" }])
    } finally {
      await t.close()
    }
  })

  // AQU-2438: the sweep repairs every linked file on each sync, not only the
  // ones a window touched, so what "never overwrites" protects has to be said
  // precisely. A file the language project imported ITSELF is a copy of
  // nothing — no `meta.upstreamFileId` stamp and not the mirror's derived id —
  // so the sweep never pairs it and its original stays its own. The linked copy
  // beside it points at the UPSTREAM's current object, which it keeps following
  // (AQU-2345: "when the upstream re-imports the file, the copy follows").
  it("never overwrites an original a file of the project's own recorded itself", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamIdmlFile(t)
      await mirrorSync(t.db, DOWNSTREAM)
      // The control case: a file imported into the language project directly
      // from IDML has its own bytes, and they stay its own.
      const ownFile = "file-own-idml-import"
      const ownKey = "artifacts/own/import.idml"
      await t.pg.query(
        `INSERT INTO files (id, project_id, name, kind, event_id, created_by, created_at, updated_at, meta)
         VALUES ($1, $2, 'Own Import', 'idml', 'evt-own-import', 'lead', 1, 1, '{}')`,
        [ownFile, DOWNSTREAM],
      )
      await t.pg.query(
        `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
         VALUES ($1, $2, 'idml', NULL, $3, $4, 1)`,
        [ownFile, DOWNSTREAM, ownKey, IDML_BYTES.byteLength],
      )

      await mirrorSync(t.db, DOWNSTREAM)

      const rows = await blobRows(t, DOWNSTREAM)
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.file_id === ownFile)).toMatchObject({ r2_key: ownKey })
      expect(rows.find((r) => r.file_id === DOWNSTREAM_FILE)).toMatchObject({ r2_key: R2_KEY })
      // Its type is the project's own too: the sweep leaves the row alone.
      const own = await t.pg.query<{ kind: string | null }>(`SELECT kind FROM files WHERE id = $1`, [ownFile])
      expect(own.rows[0]?.kind).toBe("idml")
    } finally {
      await t.close()
    }
  })

  it("writes nothing when the upstream has no original either", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await emitUpstream(t, "file.create", {
        fileId: FILE,
        payload: { name: "Typed in by hand", fileType: "codex" },
      })
      await emitUpstream(t, "source.cell.create", {
        fileId: FILE,
        cellId: "c1",
        payload: { cellId: "c1", value: "line", anchorCellId: null },
      })

      expect((await mirrorSync(t.db, DOWNSTREAM)).filesMirrored).toBe(1)

      expect(await blobRows(t, DOWNSTREAM)).toHaveLength(0)
      expect((await exportDownstream(t.db)).status).toBe(404)
    } finally {
      await t.close()
    }
  })
})
