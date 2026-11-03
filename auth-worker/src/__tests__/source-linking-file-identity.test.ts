// AQU-1358: the clone/detach snapshot must track the UPSTREAM FILE ID, not the
// display name.
//
// `snapshotSourceFiles` used to ask "is there already a target file with this
// name?" — the only stable cross-run key available once ids diverge. It isn't
// stable: rename a file upstream and the lookup misses, so the next snapshot
// minted a SECOND target row beside the one it should have renamed. Partners
// saw that as duplicate files downstream.
//
// The target copy now records `meta.upstreamFileId` on first write and matches
// on it thereafter.
//
// AQU-1547 then removed the name fallback entirely: a name cannot tell the copy
// a link brought in from a file the project imported itself, and adopting the
// latter overwrote real translated work. See
// source-linking-detach-own-files.test.ts.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { snapshotSourceFiles, withUpstreamFileId, readUpstreamFileId } from "../services/source-linking"

const UPSTREAM = "proj-identity-up"
const TARGET = "proj-identity-down"

async function seedProject(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(id, name, 1)
    .run()
}

async function seedUpstreamFile(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at)
     VALUES (?, ?, ?, 'codex', ?, 1000, 1000)`,
  )
    .bind(id, UPSTREAM, name, `e-${id}`)
    .run()
}

async function renameUpstreamFile(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare(`UPDATE files SET name = ? WHERE id = ?`).bind(name, id).run()
}

async function targetFiles(): Promise<{ id: string; name: string; meta: string }[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT id, name, meta FROM files WHERE project_id = ? ORDER BY name`,
  )
    .bind(TARGET)
    .all<{ id: string; name: string; meta: string }>()
  return rows.results ?? []
}

describe("snapshotSourceFiles — stable upstream identity (AQU-1358)", () => {
  it("re-snapshotting after an upstream rename renames in place instead of minting a duplicate", async () => {
    await seedProject(UPSTREAM, "Upstream")
    await seedProject(TARGET, "Target")
    await seedUpstreamFile("up-gen", "Genesis")
    await seedUpstreamFile("up-exo", "Exodus")

    const first = await snapshotSourceFiles(env, {
      upstreamProjectId: UPSTREAM,
      targetProjectId: TARGET,
      authorUsername: "tester",
    })
    expect(first.size).toBe(2)
    const seeded = await targetFiles()
    expect(seeded).toHaveLength(2)
    expect(readUpstreamFileId(seeded[0]?.meta ?? null)).toBeTruthy()

    // Rename upstream, then re-snapshot (detach, or a repeated clone link).
    await renameUpstreamFile("up-gen", "Genesis (Revised)")
    const second = await snapshotSourceFiles(env, {
      upstreamProjectId: UPSTREAM,
      targetProjectId: TARGET,
      authorUsername: "tester",
    })

    const after = await targetFiles()
    expect(after).toHaveLength(2) // NOT 3 — the rename did not mint a duplicate
    expect(after.map((f) => f.name).sort()).toEqual(["Exodus", "Genesis (Revised)"])
    // Same target row id as the first pass — downstream content stays attached.
    expect(second.get("up-gen")).toBe(first.get("up-gen"))
    expect(second.get("up-exo")).toBe(first.get("up-exo"))
  })

  it("repeated snapshots with nothing changed upstream are idempotent", async () => {
    await seedProject(UPSTREAM, "Upstream")
    await seedProject(TARGET, "Target")
    await seedUpstreamFile("up-lev", "Leviticus")

    const args = { upstreamProjectId: UPSTREAM, targetProjectId: TARGET, authorUsername: "tester" }
    const a = await snapshotSourceFiles(env, args)
    const b = await snapshotSourceFiles(env, args)
    const c = await snapshotSourceFiles(env, args)

    expect(await targetFiles()).toHaveLength(1)
    expect(b.get("up-lev")).toBe(a.get("up-lev"))
    expect(c.get("up-lev")).toBe(a.get("up-lev"))
  })

  it("AQU-1547: leaves an unmarked same-named row alone and copies to a new one", async () => {
    await seedProject(UPSTREAM, "Upstream")
    await seedProject(TARGET, "Target")
    await seedUpstreamFile("up-num", "Numbers")
    // An unmarked target row sharing the upstream file's name. This used to be
    // ADOPTED — the name was read as "a legacy copy of this upstream file". It
    // is just as likely to be the project's own import (AQU-1526 allows the
    // collision outright), and overwriting that destroyed translated work, so
    // identity is now required: no marker, no deterministic mirror id, no match.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
       VALUES ('legacy-num', ?, 'Numbers', 'codex', 'e-legacy', 1000, 1000, '{}')`,
    )
      .bind(TARGET)
      .run()

    const map = await snapshotSourceFiles(env, {
      upstreamProjectId: UPSTREAM,
      targetProjectId: TARGET,
      authorUsername: "tester",
    })

    expect(map.get("up-num")).not.toBe("legacy-num")
    const after = await targetFiles()
    expect(after).toHaveLength(2)
    // The pre-existing row is untouched; the fresh copy carries the marker.
    const legacy = after.find((f) => f.id === "legacy-num")
    expect(readUpstreamFileId(legacy?.meta ?? null)).toBeNull()
    const fresh = after.find((f) => f.id !== "legacy-num")
    expect(readUpstreamFileId(fresh?.meta ?? null)).toBe("up-num")
  })
})

describe("withUpstreamFileId / readUpstreamFileId", () => {
  it("round-trips the marker while preserving existing meta keys", () => {
    const meta = withUpstreamFileId('{"corpusMarker":"OT"}', "up-1")
    expect(JSON.parse(meta)).toEqual({ corpusMarker: "OT", upstreamFileId: "up-1" })
    expect(readUpstreamFileId(meta)).toBe("up-1")
  })

  it("degrades to a fresh object on malformed or non-object meta rather than throwing", () => {
    expect(JSON.parse(withUpstreamFileId("not json", "up-2"))).toEqual({ upstreamFileId: "up-2" })
    expect(JSON.parse(withUpstreamFileId("[1,2]", "up-3"))).toEqual({ upstreamFileId: "up-3" })
    expect(JSON.parse(withUpstreamFileId(null, "up-4"))).toEqual({ upstreamFileId: "up-4" })
  })

  it("reads nothing out of meta that has no usable marker", () => {
    expect(readUpstreamFileId(null)).toBeNull()
    expect(readUpstreamFileId("{}")).toBeNull()
    expect(readUpstreamFileId("not json")).toBeNull()
    expect(readUpstreamFileId('{"upstreamFileId":""}')).toBeNull()
    expect(readUpstreamFileId('{"upstreamFileId":7}')).toBeNull()
  })
})

// AQU-2345: a clone (or detach) copy is the upstream file's material, so its
// original is the upstream's. `snapshotSourceFiles` copied `kind` with the row
// but wrote no `file_source_blobs` row, so a copy's export answered "no source
// blob recorded for this file". The copy now gets a pointer row at the
// upstream's R2 object (db/shared/link-file-provenance.ts) — never an adopted
// file, which is the project's own import with its own original.
describe("snapshotSourceFiles — a copy points at the upstream's original (AQU-2345)", () => {
  const UPSTREAM_BLOB = { format: "idml", r2_key: `artifacts/${UPSTREAM}/art-fg/original.idml`, size_bytes: 1234 }

  async function seedBlob(fileId: string, projectId: string, blob: { format: string; r2_key: string; size_bytes: number }): Promise<void> {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, 1000)`,
    )
      .bind(fileId, projectId, blob.format, blob.r2_key, blob.size_bytes)
      .run()
  }

  async function blobOf(fileId: string): Promise<{ project_id: string; format: string; r2_key: string | null; size_bytes: string | number } | null> {
    return env.AQUILLA_PG.prepare(`SELECT project_id, format, r2_key, size_bytes FROM file_source_blobs WHERE file_id = ?`)
      .bind(fileId)
      .first<{ project_id: string; format: string; r2_key: string | null; size_bytes: string | number }>()
  }

  it("writes a pointer row for each copy and leaves an adopted file's own original alone", async () => {
    await seedProject(UPSTREAM, "Upstream")
    await seedProject(TARGET, "Target")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at) VALUES (?, ?, ?, 'idml', ?, 1000, 1000)`,
    )
      .bind("up-fg", UPSTREAM, "Facilitator Guide.idml", "e-up-fg")
      .run()
    await seedBlob("up-fg", UPSTREAM, UPSTREAM_BLOB)
    await seedUpstreamFile("up-mrk", "Mark")
    await seedBlob("up-mrk", UPSTREAM, { format: "usfm", r2_key: `artifacts/${UPSTREAM}/art-mrk/original.usfm`, size_bytes: 2 })
    // The target's own Mark, followed under the link, with its own original.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at) VALUES (?, ?, ?, 'usfm', ?, 1000, 1000)`,
    )
      .bind("own-mrk", TARGET, "Mark.usfm", "e-own-mrk")
      .run()
    const ownBlob = { format: "usfm", r2_key: `artifacts/${TARGET}/art-own/original.usfm`, size_bytes: 3 }
    await seedBlob("own-mrk", TARGET, ownBlob)

    const map = await snapshotSourceFiles(env, {
      upstreamProjectId: UPSTREAM,
      targetProjectId: TARGET,
      authorUsername: "lead",
      adoptedFileIdOf: { "up-mrk": "own-mrk" },
    })

    const copyId = map.get("up-fg")!
    expect(copyId).toBeTruthy()
    const copy = await env.AQUILLA_PG.prepare(`SELECT kind FROM files WHERE id = ?`).bind(copyId).first<{ kind: string }>()
    expect(copy?.kind).toBe("idml")
    expect(await blobOf(copyId)).toEqual({ project_id: TARGET, ...UPSTREAM_BLOB, size_bytes: expect.anything() })
    expect(Number((await blobOf(copyId))?.size_bytes)).toBe(1234)
    expect(map.get("up-mrk")).toBe("own-mrk")
    const own = await blobOf("own-mrk")
    expect(own).toMatchObject({ project_id: TARGET, format: "usfm", r2_key: ownBlob.r2_key })
  })
})
