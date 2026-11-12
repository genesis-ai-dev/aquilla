// AQU-1547: a detach must only ever write to the files the LINK brought in.
//
// `snapshotSourceFiles` resolved "the project's copy of this upstream file" by
// `meta.upstreamFileId` and, failing that, by DISPLAY NAME. A live link's
// mirrored rows carry no marker (the mirror passes the upstream's own meta
// through verbatim), so on a first detach the match was always by name — and a
// name cannot tell a mirrored copy from a file the project imported itself.
//
// Since AQU-1525 an ESTABLISHED project can be linked, and AQU-1526 explicitly
// allows an upstream file to share a name with one the project already has. So
// the row the name lookup picked was often the project's own work: its source
// cells were overwritten with the upstream's text, cells only the upstream had
// were appended, and its translations were left sitting against source they
// were never made from. The lookup also considered Recently deleted, so a
// tombstoned file came back changed when restored.
//
// The match is now identity-only — the marker, else the deterministic id a
// live mirror gives its rows — and never considers a deleted row. When neither
// identity matches, the upstream file is copied to a NEW row: a duplicate the
// lead can delete beats silently destroying translated work.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  deterministicDownstreamFileId,
  readUpstreamFileId,
  snapshotSourceCells,
  snapshotSourceFiles,
} from "../services/source-linking"

const UP = "proj-1547-up"
const DOWN = "proj-1547-down"

/** The project's own file — the thing the detach must not touch. */
const OWN_FILE = "own-act-rev"
const SHARED_NAME = "ACT-REV"

async function seedProject(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(id, name)
    .run()
}

async function seedFile(
  projectId: string,
  fileId: string,
  name: string,
  opts?: { meta?: string; deletedAt?: number },
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta, deleted_at)
     VALUES (?, ?, ?, 'text', ?, 1000, 1000, ?, ?)`,
  )
    .bind(fileId, projectId, name, `e-${fileId}`, opts?.meta ?? "{}", opts?.deletedAt ?? null)
    .run()
}

/** The upstream's `ACT-REV`, whose source text differs from the project's own. */
async function seedUpstream(): Promise<void> {
  await seedFile(UP, "up-act-rev", SHARED_NAME)
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at) VALUES
       (?, 'up-act-rev', 'c1', 'source', 'UPSTREAM Acts 1:1', 'ACT 1:1', 'e-up-c1', 2000),
       (?, 'up-act-rev', 'c2', 'source', 'UPSTREAM Acts 1:2', 'ACT 1:2', 'e-up-c2', 2000),
       (?, 'up-act-rev', 'c9', 'source', 'UPSTREAM only cell', 'ACT 9:9', 'e-up-c9', 2000)`,
  )
    .bind(UP, UP, UP)
    .run()
}

/**
 * The project's own `ACT-REV`: two source cells it imported itself, one of
 * them translated and validated.
 */
async function seedOwnWork(fileId = OWN_FILE, opts?: { deletedAt?: number }): Promise<void> {
  await seedFile(DOWN, fileId, SHARED_NAME, { deletedAt: opts?.deletedAt })
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at, validated) VALUES
       (?, ?, 'c1', 'source', 'OWN Acts 1:1', 'ACT 1:1', 'e-own-c1', 1000, 0),
       (?, ?, 'c2', 'source', 'OWN Acts 1:2', 'ACT 1:2', 'e-own-c2', 1000, 0),
       (?, ?, 'c1', 'target', 'our translation of 1:1', 'ACT 1:1', 'e-own-t1', 1000, 1)`,
  )
    .bind(DOWN, fileId, DOWN, fileId, DOWN, fileId)
    .run()
}

async function cellsOf(fileId: string): Promise<
  { cell_id: string; side: string; value: string; event_id: string; validated: number }[]
> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT cell_id, side, value, event_id, validated FROM cells
      WHERE project_id = ? AND file_id = ? ORDER BY side, cell_id`,
  )
    .bind(DOWN, fileId)
    .all<{ cell_id: string; side: string; value: string; event_id: string; validated: number }>()
  return rows.results ?? []
}

async function eventCountFor(fileId: string): Promise<number> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT COUNT(*)::int AS n FROM events WHERE project_id = ? AND file_id = ?`,
  )
    .bind(DOWN, fileId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

async function filesNamed(name: string): Promise<{ id: string; meta: string; deleted_at: number | null }[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT id, meta, deleted_at FROM files WHERE project_id = ? AND name = ? ORDER BY created_at`,
  )
    .bind(DOWN, name)
    .all<{ id: string; meta: string; deleted_at: number | null }>()
  return rows.results ?? []
}

const detach = () =>
  snapshotSourceCells(env, {
    upstreamProjectId: UP,
    targetProjectId: DOWN,
    authorUsername: "detaching-lead",
  })

describe("detach never writes to the project's own files (AQU-1547)", () => {
  it("Variant 1 — a link that never mirrored: the own same-named file is untouched and a new file is created", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Established project")
    await seedUpstream()
    await seedOwnWork()

    const before = await cellsOf(OWN_FILE)
    const eventsBefore = await eventCountFor(OWN_FILE)

    expect(await detach()).toBeGreaterThan(0)

    // The own file keeps its source text, its translation and its validation,
    // and gained no events from the detach.
    expect(await cellsOf(OWN_FILE)).toEqual(before)
    expect(await eventCountFor(OWN_FILE)).toBe(eventsBefore)

    // The upstream file arrived as a second, separate row.
    const named = await filesNamed(SHARED_NAME)
    expect(named).toHaveLength(2)
    const fresh = named.find((f) => f.id !== OWN_FILE)
    expect(fresh).toBeDefined()
    expect(readUpstreamFileId(fresh?.meta ?? null)).toBe("up-act-rev")
    const freshCells = await cellsOf(fresh!.id)
    expect(freshCells.map((c) => c.value).sort()).toEqual([
      "UPSTREAM Acts 1:1",
      "UPSTREAM Acts 1:2",
      "UPSTREAM only cell",
    ])
  })

  it("Variant 2 — a healthy live link: the mirrored copy is the frozen copy, the own file is untouched, no third file", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Established project")
    await seedUpstream()
    await seedOwnWork()
    // A row as the live mirror writes it: deterministic id, no marker of its
    // own (the mirror passed the upstream's meta through).
    const mirroredId = deterministicDownstreamFileId(DOWN, "up-act-rev")
    await seedFile(DOWN, mirroredId, SHARED_NAME)

    const before = await cellsOf(OWN_FILE)

    await detach()

    expect(await cellsOf(OWN_FILE)).toEqual(before)
    const named = await filesNamed(SHARED_NAME)
    expect(named).toHaveLength(2) // own + mirrored; NOT a third
    expect(named.map((f) => f.id).sort()).toEqual([OWN_FILE, mirroredId].sort())
    // The mirrored row is the one that became the frozen copy.
    const mirrored = named.find((f) => f.id === mirroredId)
    expect(readUpstreamFileId(mirrored?.meta ?? null)).toBe("up-act-rev")
    expect((await cellsOf(mirroredId)).map((c) => c.value).sort()).toEqual([
      "UPSTREAM Acts 1:1",
      "UPSTREAM Acts 1:2",
      "UPSTREAM only cell",
    ])
  })

  it("Variant 3 — a namesake in Recently deleted is never written to", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Established project")
    await seedUpstream()
    await seedOwnWork(OWN_FILE, { deletedAt: 1_700_000_000_000 })

    const before = await cellsOf(OWN_FILE)

    await detach()

    expect(await cellsOf(OWN_FILE)).toEqual(before)
    // Still tombstoned, and still unclaimed by the upstream file.
    const named = await filesNamed(SHARED_NAME)
    const deleted = named.find((f) => f.id === OWN_FILE)
    expect(deleted?.deleted_at).toBe(1_700_000_000_000)
    expect(readUpstreamFileId(deleted?.meta ?? null)).toBeNull()
    expect(named).toHaveLength(2)
  })

  it("a second detach re-uses the frozen copy it made rather than duplicating it", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Established project")
    await seedUpstream()
    await seedOwnWork()

    const first = await snapshotSourceFiles(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "detaching-lead",
    })
    const second = await snapshotSourceFiles(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "detaching-lead",
    })

    expect(second.get("up-act-rev")).toBe(first.get("up-act-rev"))
    expect(first.get("up-act-rev")).not.toBe(OWN_FILE)
    expect(await filesNamed(SHARED_NAME)).toHaveLength(2)
  })
})
