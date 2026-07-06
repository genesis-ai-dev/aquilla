// FRO-477: inherited staleness — the per-hop chain walk (design spec §6).
//
// The canonical three-project chain from the issue: A (English, source) ->
// B (French, live-linked to A, consumes='source') -> C (Chaluba, live-
// linked to B, consumes='target'). Covers:
//   - dormant-middle-hop: A edits, B never re-syncs/re-translates, C STILL
//     flags the cell via upstreamStaleCellIds (the case direct staleness
//     alone cannot see)
//   - lineage-granular negative: a cell in B untouched by A's edit shows no
//     flag anywhere in C
//   - resolution: once B re-translates + validates and C syncs, the
//     inherited flag clears (superseded by, then resolved from, direct
//     staleness)

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { handleStaleSourceRequest } from "../events/stale-source-route"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "test-secret"
const A = "proj-a-english"
const B = "proj-b-french"
const C = "proj-c-chaluba"
const FILE_A = "file-episode-1"
const FILE_B = deterministicDownstreamFileId(B, FILE_A)
const FILE_C = deterministicDownstreamFileId(C, FILE_B)

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-inh-${_seq}`
}

async function nextSeqFor(t: TestDb, projectId: string): Promise<number> {
  const row = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  return Number(row.rows[0]?.next_seq ?? 1)
}

/** Emit one event directly into `projectId`'s log through the front-door
 *  projection, with a real allocated server_seq + strictly increasing ts
 *  (see FRO-477's link-sync-target-consumption.test.ts for why: cell.validate's
 *  re-decision guard needs decided_ts to strictly increase). */
async function emit(
  t: TestDb,
  projectId: string,
  kind: string,
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown>; author?: string },
): Promise<{ id: string; seq: number }> {
  const id = nextId()
  const seq = await nextSeqFor(t, projectId)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, $6, $7, $8, $8, $9)`,
    [id, projectId, args.fileId ?? null, args.cellId ?? null, kind, args.author ?? "author", JSON.stringify(args.payload), seq, seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId: null,
    kind: kind as PersistedEvent["kind"],
    author: args.author ?? "author",
    payload: args.payload,
    clientTs: seq,
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return { id, seq }
}

async function makeToken(projectId: string, fileId: string): Promise<string> {
  return makeTestToken(SECRET, { projectId, fileId, role: 100 })
}

async function fetchStale(t: TestDb, projectId: string, fileId: string) {
  const token = await makeToken(projectId, fileId)
  const req = new Request(
    `https://sync.test/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/stale-source`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const res = await handleStaleSourceRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  return (await (res as Response).json()) as {
    staleCellIds: string[]
    upstreamStaleCellIds: string[]
    tombstonedCellIds: string[]
    behindSeq: unknown
  }
}

/** Seed the full chain: A has two cells; B is live-linked to A
 *  (consumes='source') and has translated + validated BOTH; C is
 *  live-linked to B (consumes='target', gate='validated') and has mirrored
 *  + committed a Chaluba target for BOTH. */
async function seedChain(t: TestDb): Promise<{ cellStable: string; cellEdited: string }> {
  const cellStable = "cell-stable"
  const cellEdited = "cell-edited"

  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'English', 1)`, [A])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'French', 1, $2, 'live', 'source', 0)`,
    [B, A],
  )
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor)
     VALUES ($1, 'Chaluba', 1, $2, 'live', 'target', 'validated', 0)`,
    [C, B],
  )

  await emit(t, A, "file.create", { fileId: FILE_A, payload: { name: "Episode 1", fileType: "codex" } })
  await emit(t, A, "source.cell.create", {
    fileId: FILE_A,
    cellId: cellStable,
    payload: { cellId: cellStable, value: "Peace be with you", anchorCellId: null },
  })
  await emit(t, A, "source.cell.create", {
    fileId: FILE_A,
    cellId: cellEdited,
    payload: { cellId: cellEdited, value: "original English line", anchorCellId: null },
  })

  // B mirrors A (consumes='source').
  await mirrorSync(t.db, B)

  // B translates + validates both cells.
  for (const cellId of [cellStable, cellEdited]) {
    const bSource = await t.pg.query<{ event_id: string }>(
      `SELECT event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
      [B, FILE_B, cellId],
    )
    const sourceEventId = bSource.rows[0]?.event_id
    const commit = await emit(t, B, "target.cell.commit", {
      fileId: FILE_B,
      cellId,
      payload: { value: `french-${cellId}`, sourceEventId },
      author: "translator-b",
    })
    await emit(t, B, "cell.validate", {
      fileId: FILE_B,
      cellId,
      payload: { editEventId: commit.id },
      author: "reviewer-b",
    })
  }

  // C mirrors B (consumes='target', gate='validated').
  await mirrorSync(t.db, C)

  // C translates + validates both cells too (so C has committed targets
  // pinned to its mirrored source head, for the direct-stale check).
  for (const cellId of [cellStable, cellEdited]) {
    const cSource = await t.pg.query<{ event_id: string }>(
      `SELECT event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
      [C, FILE_C, cellId],
    )
    const sourceEventId = cSource.rows[0]?.event_id
    await emit(t, C, "target.cell.commit", {
      fileId: FILE_C,
      cellId,
      payload: { value: `chaluba-${cellId}`, sourceEventId },
      author: "translator-c",
    })
  }

  return { cellStable, cellEdited }
}

describe("inherited staleness — dormant-middle-hop (A->B->C chain)", () => {
  it("A edits a cell; B never re-syncs; C STILL flags that cell via upstreamStaleCellIds", async () => {
    const t = await makeTestDb()
    try {
      const { cellEdited } = await seedChain(t)

      // Sanity: before the edit, C has no direct or inherited staleness.
      const before = await fetchStale(t, C, FILE_C)
      expect(before.staleCellIds).toEqual([])
      expect(before.upstreamStaleCellIds).toEqual([])

      // English is fixed. B is DORMANT — never re-syncs, never re-translates.
      await emit(t, A, "source.cell.commit", {
        fileId: FILE_A,
        cellId: cellEdited,
        payload: { value: "original English line (FIXED)" },
      })

      // C's own mirror of B hasn't changed (B never re-committed), so C's
      // DIRECT staleness (pin vs local mirrored B-source head) sees nothing
      // new for this cell — this is exactly the gap direct staleness alone
      // cannot see.
      const after = await fetchStale(t, C, FILE_C)
      expect(after.staleCellIds).not.toContain(cellEdited)

      // But the inherited walk must flag it immediately: step 1 (mirror
      // check) compares C's local mirrored-source `upstream_event_id` for
      // this cell (pointing at B's target commit) against B's CURRENT
      // target-lane head for that cell_id — unchanged, so step 1 alone
      // wouldn't catch it either. It's step 2 (the side switch) that fires:
      // B's own target row is now stale against B's sibling source row
      // (B's mirrored English text moved), so C inherits that staleness.
      expect(after.upstreamStaleCellIds).toContain(cellEdited)
    } finally {
      await t.close()
    }
  })

  it("a cell in B never touched by A's edit shows NO flag anywhere in C (lineage-granular negative)", async () => {
    const t = await makeTestDb()
    try {
      const { cellStable, cellEdited } = await seedChain(t)

      await emit(t, A, "source.cell.commit", {
        fileId: FILE_A,
        cellId: cellEdited,
        payload: { value: "original English line (FIXED)" },
      })

      const after = await fetchStale(t, C, FILE_C)
      expect(after.upstreamStaleCellIds).toContain(cellEdited)
      // The untouched cell must NOT be flagged — invalidation is cell-
      // lineage granular, not file- or project-wide.
      expect(after.upstreamStaleCellIds).not.toContain(cellStable)
      expect(after.staleCellIds).not.toContain(cellStable)
    } finally {
      await t.close()
    }
  })

  it("after B re-translates + validates and C syncs, the inherited flag resolves to direct-stale, then clears on re-commit", async () => {
    const t = await makeTestDb()
    try {
      const { cellEdited } = await seedChain(t)
      await emit(t, A, "source.cell.commit", {
        fileId: FILE_A,
        cellId: cellEdited,
        payload: { value: "original English line (FIXED)" },
      })

      const inheritedPhase = await fetchStale(t, C, FILE_C)
      expect(inheritedPhase.upstreamStaleCellIds).toContain(cellEdited)

      // B catches up: mirrors A, re-translates + re-validates.
      await mirrorSync(t.db, B)
      const bSource = await t.pg.query<{ event_id: string }>(
        `SELECT event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [B, FILE_B, cellEdited],
      )
      const commit2 = await emit(t, B, "target.cell.commit", {
        fileId: FILE_B,
        cellId: cellEdited,
        payload: { value: "french-cell-edited (v2)", sourceEventId: bSource.rows[0]?.event_id },
        author: "translator-b",
      })
      await emit(t, B, "cell.validate", {
        fileId: FILE_B,
        cellId: cellEdited,
        payload: { editEventId: commit2.id },
        author: "reviewer-b",
      })

      // C syncs — its mirror of B now advances, so DIRECT staleness takes
      // over (C's committed Chaluba target is pinned to the OLD mirrored
      // French text).
      await mirrorSync(t.db, C)
      const directPhase = await fetchStale(t, C, FILE_C)
      expect(directPhase.staleCellIds).toContain(cellEdited)
      expect(directPhase.upstreamStaleCellIds).not.toContain(cellEdited)

      // C re-commits, pinned to the new mirrored head — clears entirely.
      const cSource = await t.pg.query<{ event_id: string }>(
        `SELECT event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
        [C, FILE_C, cellEdited],
      )
      await emit(t, C, "target.cell.commit", {
        fileId: FILE_C,
        cellId: cellEdited,
        payload: { value: "chaluba-cell-edited (v2)", sourceEventId: cSource.rows[0]?.event_id },
        author: "translator-c",
      })

      const clearedPhase = await fetchStale(t, C, FILE_C)
      expect(clearedPhase.staleCellIds).not.toContain(cellEdited)
      expect(clearedPhase.upstreamStaleCellIds).not.toContain(cellEdited)
    } finally {
      await t.close()
    }
  })
})

describe("inherited staleness — cycle safety", () => {
  it("does not infinite-loop on a malformed cyclic chain (bounded by MAX_HOPS)", async () => {
    const t = await makeTestDb()
    try {
      // Deliberately malformed: X points at Y, Y points at X.
      await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'X', 1)`, ["proj-x"])
      await t.pg.query(
        `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes) VALUES ($1, 'Y', 1, $2, 'live', 'source')`,
        ["proj-y", "proj-x"],
      )
      await t.pg.query(`UPDATE projects SET source_project_id = 'proj-y', source_link_mode = 'live', source_link_consumes = 'source' WHERE id = 'proj-x'`)
      await emit(t, "proj-x", "file.create", { fileId: "f", payload: { name: "F", fileType: "codex" } })

      const token = await makeToken("proj-x", "f")
      const req = new Request(
        `https://sync.test/api/v1/projects/proj-x/files/f/stale-source`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const res = await handleStaleSourceRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
      expect(res).not.toBeNull()
      expect((res as Response).status).toBe(200)
    } finally {
      await t.close()
    }
  })
})
