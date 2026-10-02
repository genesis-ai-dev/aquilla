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
