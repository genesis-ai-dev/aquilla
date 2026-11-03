// AQU-2345: a file copied in by the clone/detach snapshot keeps its original
// artifact, so it can still be exported.
//
// `snapshotSourceCells` copies the upstream's `files` row and its cells and
// said nothing about where the file's original upload lives. That record is one
// `file_source_blobs` row, and it is the only thing the export route resolves
// original bytes through (sync-worker `events/export-route.ts`) and the only
// thing `hasOriginalSource` is read off — so an IDML file brought in this way
// reported `hasOriginalSource: false` and 404'd on export with "no source blob
// recorded for this file". Same bug, same fix, as the live mirror's half of it
// (sync-worker `__tests__/link-sync-source-blob.test.ts`): the downstream row
// POINTS at the upstream row's R2 object, so no bytes are copied and both
// projects' exports read the same object.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { snapshotSourceCells } from "../services/source-linking"

const UP = "proj-blob-up"
const DOWN = "proj-blob-down"
const R2_KEY = "artifacts/proj-blob-up/facilitator-guide.idml"

async function seedProject(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(id, name)
    .run()
}

/** An upstream IDML import: one file, one cell, bytes recorded in R2. */
async function seedUpstream(withBlob = true): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at)
     VALUES ('f-fg', ?, 'Facilitator Guide', 'text', 'e-file', 1000, 1000)`,
  )
    .bind(UP)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
     VALUES (?, 'f-fg', 'Stories/Story_u1a.xml#1', 'source', 'Welcome', 'e-c1', 1000)`,
  )
    .bind(UP)
    .run()
  if (!withBlob) return
  await env.AQUILLA_PG.prepare(
    `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
     VALUES ('f-fg', ?, 'idml', NULL, ?, 8, 1)`,
  )
    .bind(UP, R2_KEY)
    .run()
}

interface BlobRow {
  file_id: string
  format: string
  raw_source: string | null
  r2_key: string | null
  size_bytes: number | string | null
}

async function downstreamBlobs(): Promise<BlobRow[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT file_id, format, raw_source, r2_key, size_bytes
       FROM file_source_blobs WHERE project_id = ? ORDER BY file_id`,
  )
    .bind(DOWN)
    .all<BlobRow>()
  return rows.results ?? []
}

async function downstreamFileId(): Promise<string> {
  const row = await env.AQUILLA_PG.prepare(`SELECT id FROM files WHERE project_id = ?`)
    .bind(DOWN)
    .first<{ id: string }>()
  return row!.id
}

describe("snapshotSourceCells — a copied file keeps its original artifact (AQU-2345)", () => {
  it("points the copy's side-car at the upstream's R2 object, copying no bytes", async () => {
    await seedProject(UP, "EBL Source Material")
    await seedProject(DOWN, "Portuguese EBL")
    await seedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    const blobs = await downstreamBlobs()
    expect(blobs).toHaveLength(1)
    expect(blobs[0]).toMatchObject({
      file_id: await downstreamFileId(),
      format: "idml",
      r2_key: R2_KEY,
      raw_source: null,
    })
    // The upstream keeps its own row, unchanged.
    const upstream = await env.AQUILLA_PG.prepare(
      `SELECT r2_key FROM file_source_blobs WHERE project_id = ?`,
    )
      .bind(UP)
      .all<{ r2_key: string }>()
    expect(upstream.results).toMatchObject([{ r2_key: R2_KEY }])
  })

  it("is idempotent — a second snapshot neither duplicates nor rewrites the row", async () => {
    await seedProject(UP, "EBL Source Material")
    await seedProject(DOWN, "Portuguese EBL")
    await seedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })
    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    expect(await downstreamBlobs()).toMatchObject([{ r2_key: R2_KEY }])
  })

  it("writes nothing when the upstream recorded no original either", async () => {
    await seedProject(UP, "EBL Source Material")
    await seedProject(DOWN, "Portuguese EBL")
    await seedUpstream(false)

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    expect(await downstreamBlobs()).toHaveLength(0)
  })
})
