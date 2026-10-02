// AQU-1547: a mirrored downstream file records WHICH upstream file it mirrors.
//
// `file.mirror` passed the upstream file's own `meta` through verbatim, so the
// downstream row it projected held language/orderedBy and nothing about its
// provenance. The detach snapshot (auth-worker `snapshotSourceFiles`) had
// therefore no identity to match a mirrored copy on, and fell back to matching
// by DISPLAY NAME — which on an established project (AQU-1525/1526) picked the
// project's own same-named file and overwrote its source text.
//
// The mirror now stamps `meta.upstreamFileId`, the same key auth-worker's
// `withUpstreamFileId` writes on clone copies. (auth-worker also derives the
// deterministic downstream id as a second identity, which covers rows mirrored
// before this stamp existed — see source-linking-mirror-id-parity.test.ts.)

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-prov-upstream"
const DOWNSTREAM = "proj-prov-downstream"
const FILE = "file-act-prov"
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-prov-${_seq}`
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, 'live', 'source', 0)`,
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

async function downstreamFileMeta(t: TestDb): Promise<Record<string, unknown>> {
  const r = await t.pg.query<{ meta: string }>(`SELECT meta FROM files WHERE id = $1 AND project_id = $2`, [
    DOWNSTREAM_FILE,
    DOWNSTREAM,
  ])
  const raw = r.rows[0]?.meta
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

async function seedUpstreamFile(t: TestDb, meta?: Record<string, unknown>): Promise<void> {
  await emitUpstream(t, "file.create", {
    fileId: FILE,
    payload: { name: "ACT-REV", fileType: "codex", ...(meta ?? {}) },
  })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "cell-1",
    payload: { cellId: "cell-1", value: "Luke wrote Acts", anchorCellId: null },
  })
}

describe("mirrorSync — a mirrored file records its upstream file id (AQU-1547)", () => {
  it("stamps meta.upstreamFileId on the downstream row", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)

      expect((await mirrorSync(t.db, DOWNSTREAM)).ranSync).toBe(true)

      expect((await downstreamFileMeta(t)).upstreamFileId).toBe(FILE)
    } finally {
      await t.close()
    }
  })

  it("keeps the upstream's other meta keys alongside the stamp", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      // Whatever else the upstream file row carries must still travel.
      await t.pg.query(`UPDATE files SET meta = $1 WHERE id = $2`, [
        JSON.stringify({ orderedBy: "segments", language: "grc" }),
        FILE,
      ])

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamFileMeta(t)).toEqual({
        orderedBy: "segments",
        language: "grc",
        upstreamFileId: FILE,
      })
    } finally {
      await t.close()
    }
  })

  it("overwrites an inherited marker — an upstream that is itself a copy does not pass its parent's id down", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      // The upstream is itself a clone of a grandparent, so its own row
      // carries a marker. The downstream must record ITS upstream, not the
      // grandparent the name would otherwise lead back to.
      await t.pg.query(`UPDATE files SET meta = $1 WHERE id = $2`, [
        JSON.stringify({ upstreamFileId: "grandparent-file" }),
        FILE,
      ])

      await mirrorSync(t.db, DOWNSTREAM)

      expect((await downstreamFileMeta(t)).upstreamFileId).toBe(FILE)
    } finally {
      await t.close()
    }
  })

  it("survives a malformed legacy meta blob instead of failing the batch", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedUpstreamFile(t)
      await t.pg.query(`UPDATE files SET meta = $1 WHERE id = $2`, ["not json at all", FILE])

      expect((await mirrorSync(t.db, DOWNSTREAM)).ranSync).toBe(true)

      expect(await downstreamFileMeta(t)).toEqual({ upstreamFileId: FILE })
    } finally {
      await t.close()
    }
  })
})
