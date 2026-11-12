// AQU-1608: a one-time copy must not carry the source text of a file the
// upstream has moved to Recently deleted.
//
// `snapshotSourceCells` is the copy behind two flows — clone-mode linking at
// project creation, and detaching a live link. It copies `files` first through
// `snapshotSourceFiles`, which already skips tombstoned rows, and then read
// EVERY source cell in the upstream project with no such check. On a
// whole-project copy (every listed file left checked, the default) the deleted
// file's lines therefore arrived in the new project keyed to a `file_id` it has
// no row for: absent from the file list, but returned by project-wide search,
// which matches on `project_id` alone, and counted as an extra unnamed file by
// the health rollup, which builds its file list from `DISTINCT file_id`.
//
// A subset copy was never affected — the selection cannot list a file the
// upstream has deleted — so the regression guard below pins both shapes.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { snapshotSourceCells } from "../services/source-linking"

const UP = "proj-del-up"
const DOWN = "proj-del-down"

async function seedProject(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(id, name)
    .run()
}

async function seedFile(id: string, name: string, deletedAt: number | null): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, 'text', ?, 1000, 1000, ?)`,
  )
    .bind(id, UP, name, `e-${id}`, deletedAt)
    .run()
}

/** `GEN` and `EXO` live, `LEV` in Recently deleted — the ticket's repro. */
async function seedUpstreamWithDeletedFile(): Promise<void> {
  await seedFile("f-gen", "01-GEN.usfm", null)
  await seedFile("f-exo", "02-EXO.usfm", null)
  await seedFile("f-lev", "03-LEV.usfm", 1700000000000)
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at) VALUES
       (?, 'f-gen', 'g1', 'source', 'In the beginning', 'GEN 1:1', 'e-g1', 1000),
       (?, 'f-exo', 'x1', 'source', 'These are the names', 'EXO 1:1', 'e-x1', 1000),
       (?, 'f-lev', 'l1', 'source', 'zzdeletedmarker', 'LEV 1:1', 'e-l1', 1000)`,
  )
    .bind(UP, UP, UP)
    .run()
}

/** The snapshot remaps file ids (files.id is a global PK), so read the target's
 *  rows by cell id and let the file id fall out of the query. */
async function targetCellValues(): Promise<Map<string, string>> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT cell_id, value FROM cells WHERE project_id = ? AND side = 'source'`,
  )
    .bind(DOWN)
    .all<{ cell_id: string; value: string }>()
  return new Map((rows.results ?? []).map((r) => [r.cell_id, r.value]))
}

/** What project-wide search and the health rollup read: the distinct file ids
 *  the project's own source rows point at. Every one must be a file this
 *  project actually has. */
async function targetFileIdsFromCells(): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT DISTINCT file_id FROM cells WHERE project_id = ? AND side = 'source'`,
  )
    .bind(DOWN)
    .all<{ file_id: string }>()
  return (rows.results ?? []).map((r) => r.file_id).sort()
}

async function targetFileNames(): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT name FROM files WHERE project_id = ? AND deleted_at IS NULL ORDER BY name`,
  )
    .bind(DOWN)
    .all<{ name: string }>()
  return (rows.results ?? []).map((r) => r.name)
}

describe("snapshotSourceCells — a deleted upstream file's lines stay behind (AQU-1608)", () => {
  it("copies the live files' lines and none of the deleted file's, on a whole-project copy", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedUpstreamWithDeletedFile()

    // No `onlyUpstreamFileIds` — "the whole project", which is what leaving
    // every listed file checked produces and the only shape that was broken.
    const emitted = await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })
    expect(emitted).toBe(2)

    const values = await targetCellValues()
    expect(values.get("g1")).toBe("In the beginning")
    expect(values.get("x1")).toBe("These are the names")
    // The phrase that exists only in the deleted file: nothing for search to find.
    expect(values.has("l1")).toBe(false)

    // The file list is unchanged from today — GEN and EXO only…
    expect(await targetFileNames()).toEqual(["01-GEN.usfm", "02-EXO.usfm"])
    // …and no source row points at a file outside it, so neither the health
    // rollup's `DISTINCT file_id` nor search can surface a third, unnamed file.
    const liveIds = await env.AQUILLA_PG.prepare(
      `SELECT id FROM files WHERE project_id = ? AND deleted_at IS NULL`,
    )
      .bind(DOWN)
      .all<{ id: string }>()
    expect(await targetFileIdsFromCells()).toEqual(
      (liveIds.results ?? []).map((r) => r.id).sort(),
    )
  })

  it("leaves a subset copy exactly as it was: only the checked file arrives", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedUpstreamWithDeletedFile()

    const emitted = await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
      onlyUpstreamFileIds: ["f-gen"],
    })
    expect(emitted).toBe(1)

    const values = await targetCellValues()
    expect([...values.keys()]).toEqual(["g1"])
  })

  it("drops a followed file the upstream deleted after the link was made", async () => {
    // The ticket's "unchecking a file avoids it" holds at create time only: a
    // stored selection is what the link was MADE with, so a file deleted
    // upstream afterwards is still in it. `snapshotSourceFiles` leaves it out
    // (it reads live files), so the cell copy has to as well — otherwise a
    // detach from a subset link reproduces the same stray rows.
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedUpstreamWithDeletedFile()

    const emitted = await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
      onlyUpstreamFileIds: ["f-gen", "f-lev"],
    })
    expect(emitted).toBe(1)
    expect([...(await targetCellValues()).keys()]).toEqual(["g1"])
    expect(await targetFileNames()).toEqual(["01-GEN.usfm"])
  })

  it("copies everything when the upstream has nothing in Recently deleted", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedFile("f-gen", "01-GEN.usfm", null)
    await seedFile("f-exo", "02-EXO.usfm", null)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at) VALUES
         (?, 'f-gen', 'g1', 'source', 'In the beginning', 'GEN 1:1', 'e-g1', 1000),
         (?, 'f-exo', 'x1', 'source', 'These are the names', 'EXO 1:1', 'e-x1', 1000)`,
    )
      .bind(UP, UP)
      .run()

    const emitted = await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })
    expect(emitted).toBe(2)
    expect([...(await targetCellValues()).keys()].sort()).toEqual(["g1", "x1"])
  })
})
