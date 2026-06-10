import { describe, it, expect } from "vitest"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { handleRebuildProjectionRequest } from "../events/rebuild"
import { type CellRow } from "./helpers/in-memory-db"
import { makeTestDb, type Seed } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cells-read-secret"

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function makeCell(over: Partial<CellRow> & Pick<CellRow, "cell_id" | "anchor_cell_id" | "event_id">): CellRow {
  return {
    project_id: "proj-a",
    file_id: "file-x",
    side: "target",
    value: "v",
    value_html: null,
    type: null,
    canonical_ref: null,
    last_editor: "alice",
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    source_event_id: null,
    ...over,
  }
}

describe("GET /api/v1/projects/:projectId/files/:fileId/cells", () => {
  it("returns cells in anchor-chain order (head → next → tail)", async () => {
    // Insert in a deliberately scrambled order — we want the chain walk to
    // reassemble them correctly regardless of source DB order.
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c3", anchor_cell_id: "c2", event_id: "e3" }),
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" }),
        makeCell({ cell_id: "c2", anchor_cell_id: "c1", event_id: "e2" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { cells: Array<{ cellId: string; anchorCellId: string | null }> }
    expect(body.cells.map((c) => c.cellId)).toEqual(["c1", "c2", "c3"])
  })

  it("tiebreaks two cells anchored to the same parent by event_id lex order", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "head", anchor_cell_id: null, event_id: "ev0" }),
        makeCell({ cell_id: "second", anchor_cell_id: "head", event_id: "ev2" }),
        makeCell({ cell_id: "first", anchor_cell_id: "head", event_id: "ev1" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string }> }
    // head → first (ev1, smaller) → second (ev2)
    expect(body.cells.map((c) => c.cellId)).toEqual(["head", "first", "second"])
  })

  it("respects the side filter", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "s1", side: "source", anchor_cell_id: null, event_id: "es1", value: "src-1" }),
        makeCell({ cell_id: "t1", side: "target", anchor_cell_id: null, event_id: "et1", value: "tgt-1" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    const sourceReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const sourceRes = (await handleCellsReadRequest(sourceReq, envWith(db)))!
    const sourceBody = (await sourceRes.json()) as { cells: Array<{ side: string; cellId: string }> }
    expect(sourceBody.cells).toHaveLength(1)
    expect(sourceBody.cells[0].side).toBe("source")

    const targetReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const targetRes = (await handleCellsReadRequest(targetReq, envWith(db)))!
    const targetBody = (await targetRes.json()) as { cells: Array<{ side: string }> }
    expect(targetBody.cells).toHaveLength(1)
    expect(targetBody.cells[0].side).toBe("target")
  })

  it("returns both sides when side is omitted, source-rows first then target-rows", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", side: "source", anchor_cell_id: null, event_id: "es1", value: "src" }),
        makeCell({ cell_id: "c1", side: "target", anchor_cell_id: null, event_id: "et1", value: "tgt" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string; side: string }> }
    expect(body.cells).toHaveLength(2)
    expect(body.cells[0].side).toBe("source")
    expect(body.cells[1].side).toBe("target")
  })

  it("paginates via cursor and reports nextCursor when more rows remain", async () => {
    const cells = []
    let prev: string | null = null
    for (let i = 0; i < 10; i++) {
      const id = `c${i.toString().padStart(2, "0")}`
      cells.push(makeCell({ cell_id: id, anchor_cell_id: prev, event_id: `e${id}` }))
      prev = id
    }
    const { db } = await makeTestDb({ cells })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    const firstReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=4",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const firstRes = (await handleCellsReadRequest(firstReq, envWith(db)))!
    const firstBody = (await firstRes.json()) as {
      cells: Array<{ cellId: string }>
      nextCursor: string | null
      total: number
    }
    expect(firstBody.cells.map((c) => c.cellId)).toEqual(["c00", "c01", "c02", "c03"])
    expect(firstBody.nextCursor).not.toBeNull()
    expect(firstBody.total).toBe(10)

    const secondReq = new Request(
      `https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=4&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const secondRes = (await handleCellsReadRequest(secondReq, envWith(db)))!
    const secondBody = (await secondRes.json()) as {
      cells: Array<{ cellId: string }>
      nextCursor: string | null
    }
    expect(secondBody.cells.map((c) => c.cellId)).toEqual(["c04", "c05", "c06", "c07"])
    expect(secondBody.nextCursor).not.toBeNull()
  })

  it("returns 401 without an Authorization header", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const req = new Request("https://w/api/v1/projects/proj-a/files/file-x/cells")
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "other-proj", fileId: "file-x" })
    const req = new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns start_ms/end_ms as startMs/endMs", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1", start_ms: 1500, end_ms: 3250 }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ startMs: number | null; endMs: number | null }> }
    expect(body.cells[0].startMs).toBe(1500)
    expect(body.cells[0].endMs).toBe(3250)
  })

  it("returns 400 on invalid side parameter", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=invalid",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("exposes word_count and validated as boolean", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({
          cell_id: "c1",
          anchor_cell_id: null,
          event_id: "e1",
          word_count: 7,
          validated: 1,
        }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ wordCount: number; validated: boolean }> }
    expect(body.cells[0].wordCount).toBe(7)
    expect(body.cells[0].validated).toBe(true)
  })
})

// ── Conditional reads + ?since= delta (audit M2-1 / PERF-1 / RES-1) ────────

interface EventSeed {
  id: string
  schema_version: number
  project_id: string
  file_id: string | null
  cell_id: string | null
  kind: string
  author: string
  payload: string
  client_ts: number
  server_ts: number
  server_seq: number
}

function makeEvent(
  over: Partial<EventSeed> & Pick<EventSeed, "id" | "server_seq">,
): EventSeed {
  return {
    schema_version: 1,
    project_id: "proj-a",
    file_id: "file-x",
    cell_id: null,
    kind: "target.cell.commit",
    author: "alice",
    payload: "{}",
    client_ts: 1700000000000,
    server_ts: 1700000000000,
    ...over,
  }
}

describe("conditional reads + ?since= delta", () => {
  // ETag shape is "<fileId>:<rebuiltSeq>:<maxSeq>" (audit B5); these seeds
  // never rebuilt, so rebuiltSeq is 0.
  it("sets ETag \"<fileId>:<rebuiltSeq>:<maxSeq>\" on full reads and includes maxServerSeq in the body", async () => {
    const { db } = await makeTestDb({
      cells: [makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" })],
      // Gaps are deliberate: server_seq is an ordering key, never a count.
      events: [
        makeEvent({ id: "e1", server_seq: 3, cell_id: "c1" }),
        makeEvent({ id: "e2", server_seq: 7, cell_id: "c1" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    expect(res.headers.get("ETag")).toBe('"file-x:0:7"')
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache")
    const body = (await res.json()) as { maxServerSeq: number }
    expect(body.maxServerSeq).toBe(7)
  })

  it("returns 304 with no body when If-None-Match carries the current watermark", async () => {
    const { db } = await makeTestDb({
      cells: [makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" })],
      events: [makeEvent({ id: "e1", server_seq: 5, cell_id: "c1" })],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
      headers: { Authorization: `Bearer ${token}`, "If-None-Match": '"file-x:0:5"' },
    })
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(304)
    expect(res.headers.get("ETag")).toBe('"file-x:0:5"')
    expect(await res.text()).toBe("")
  })

  it("does not 304 a stale tag — the ETag moves when a new event lands", async () => {
    const { db } = await makeTestDb({
      cells: [makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" })],
      events: [makeEvent({ id: "e1", server_seq: 5, cell_id: "c1" })],
    })
    await db
      .prepare(
        "INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("e2", 1, "proj-a", "file-x", "c1", "target.cell.commit", "bob", "{}", 1, 1, 6)
      .run()
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
      headers: { Authorization: `Bearer ${token}`, "If-None-Match": '"file-x:0:5"' },
    })
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    expect(res.headers.get("ETag")).toBe('"file-x:0:6"')
  })

  it("?since= returns only changed rows; a changed cellId with no row signals deletion", async () => {
    // c3 was deleted: its delete event is in the log but its row left the
    // projection. c2 changed after the cursor; c1 did not.
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" }),
        makeCell({ cell_id: "c2", anchor_cell_id: "c1", event_id: "e4", value: "v2-new" }),
      ],
      events: [
        makeEvent({ id: "e1", server_seq: 1, cell_id: "c1", kind: "target.cell.create" }),
        makeEvent({ id: "e2", server_seq: 2, cell_id: "c2", kind: "target.cell.create" }),
        makeEvent({ id: "e3", server_seq: 3, cell_id: "c3", kind: "target.cell.create" }),
        makeEvent({ id: "e4", server_seq: 4, cell_id: "c2" }),
        makeEvent({ id: "e5", server_seq: 5, cell_id: "c3", kind: "target.cell.delete" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?since=3",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      delta: boolean
      changedCellIds: string[]
      cells: Array<{ cellId: string; value: string }>
      maxServerSeq: number
    }
    expect(body.delta).toBe(true)
    expect([...body.changedCellIds].sort()).toEqual(["c2", "c3"])
    expect(body.cells.map((c) => c.cellId)).toEqual(["c2"])
    expect(body.cells[0].value).toBe("v2-new")
    expect(body.maxServerSeq).toBe(5)
  })

  it("?since= at the watermark returns an empty delta; NULL-cell_id events only move the watermark", async () => {
    const { db } = await makeTestDb({
      cells: [makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" })],
      events: [
        makeEvent({ id: "e1", server_seq: 1, cell_id: "c1" }),
        // file.rename bumps the file's max seq but touches no cells row.
        makeEvent({ id: "e2", server_seq: 2, cell_id: null, kind: "file.rename" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?since=1",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as {
      delta: boolean
      changedCellIds: string[]
      cells: unknown[]
      maxServerSeq: number
    }
    expect(body.delta).toBe(true)
    expect(body.changedCellIds).toEqual([])
    expect(body.cells).toEqual([])
    expect(body.maxServerSeq).toBe(2)
  })

  it("delta honors the side filter but still reports the changed cellId once", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", side: "source", anchor_cell_id: null, event_id: "es1", value: "src" }),
        makeCell({ cell_id: "c1", side: "target", anchor_cell_id: null, event_id: "et1", value: "tgt" }),
      ],
      events: [makeEvent({ id: "et1", server_seq: 9, cell_id: "c1" })],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?since=0&side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as {
      changedCellIds: string[]
      cells: Array<{ side: string; value: string }>
    }
    expect(body.changedCellIds).toEqual(["c1"])
    expect(body.cells).toHaveLength(1)
    expect(body.cells[0].side).toBe("target")
  })

  it("tells the client to resync when the changed set exceeds the delta limit", async () => {
    const events: EventSeed[] = []
    for (let i = 0; i < 501; i++) {
      events.push(makeEvent({ id: `e${i}`, server_seq: i + 1, cell_id: `c${i}` }))
    }
    const { db } = await makeTestDb({ cells: [], events })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?since=0",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { resync?: boolean; delta?: boolean; maxServerSeq: number }
    expect(body.resync).toBe(true)
    expect(body.delta).toBeUndefined()
    expect(body.maxServerSeq).toBe(501)
  })

  it("rejects a malformed since with 400", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?since=abc",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })
})

// ── Rebuild visibility (audit B5) ───────────────────────────────────────────
//
// A projection rebuild replays existing events and mints none, so
// MAX(server_seq) — the delta/ETag watermark — does not move even though
// cells rows changed. Without a rebuild marker every warm client's `?since=`
// returns an empty delta (and If-None-Match 304s) forever, pinning
// pre-rebuild values in the client's persistent IDB cache. The fix records a
// `rebuilt_seq` marker on the project's seq counter; any cursor predating it
// gets the existing `{resync:true}` response, and the marker is folded into
// the ETag.

describe("rebuild visibility (audit B5)", () => {
  /** Projection holds "corrupt" but the log says "correct" — the exact state
   *  a rebuild repairs (legacy RACE-1 damage). */
  function corruptedProjectSeed(): Seed {
    return {
      cells: [makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1", value: "corrupt" })],
      events: [
        makeEvent({
          id: "e1",
          server_seq: 1,
          cell_id: "c1",
          kind: "target.cell.create",
          payload: JSON.stringify({ cellId: "c1", value: "correct" }),
        }),
      ],
    } as unknown as Seed
  }

  async function rebuild(db: AquillaDb) {
    const res = await handleRebuildProjectionRequest(
      new Request("https://w/admin/projects/proj-a/rebuild-projection", {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
      envWith(db),
    )
    expect(res!.status).toBe(200)
  }

  it("a warm client whose since predates a rebuild is told to resync, not handed an empty delta", async () => {
    const { db } = await makeTestDb(corruptedProjectSeed())
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const deltaReq = () =>
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells?since=1", {
        headers: { Authorization: `Bearer ${token}` },
      })

    // Warm + caught up: empty delta before the rebuild.
    const before = (await handleCellsReadRequest(deltaReq(), envWith(db)))!
    const beforeBody = (await before.json()) as { delta?: boolean; changedCellIds?: string[] }
    expect(beforeBody.delta).toBe(true)
    expect(beforeBody.changedCellIds).toEqual([])

    await rebuild(db)

    // The rebuild changed c1 ("corrupt" → "correct") without minting events.
    // The same cursor must now force a resync — an empty delta would pin the
    // pre-rebuild value in the client's IDB cache indefinitely.
    const after = (await handleCellsReadRequest(deltaReq(), envWith(db)))!
    expect(after.status).toBe(200)
    const afterBody = (await after.json()) as { resync?: boolean; delta?: boolean; maxServerSeq: number }
    expect(afterBody.resync).toBe(true)
    expect(afterBody.delta).toBeUndefined()

    // The resync's full refetch hands the client a cursor PAST the marker —
    // its next delta must be a normal empty delta, not a resync loop.
    const full = (await handleCellsReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells?side=target", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    const fullBody = (await full.json()) as { cells: Array<{ value: string }>; maxServerSeq: number }
    expect(fullBody.cells[0].value).toBe("correct")
    expect(fullBody.maxServerSeq).toBeGreaterThanOrEqual(afterBody.maxServerSeq)

    const next = (await handleCellsReadRequest(
      new Request(
        `https://w/api/v1/projects/proj-a/files/file-x/cells?since=${fullBody.maxServerSeq}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      envWith(db),
    ))!
    const nextBody = (await next.json()) as { delta?: boolean; resync?: boolean; changedCellIds?: string[] }
    expect(nextBody.resync).toBeUndefined()
    expect(nextBody.delta).toBe(true)
    expect(nextBody.changedCellIds).toEqual([])
  })

  it("the ETag misses across a rebuild even though MAX(server_seq) did not move", async () => {
    const { db } = await makeTestDb(corruptedProjectSeed())
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const fullReq = (etag?: string) =>
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      })

    const first = (await handleCellsReadRequest(fullReq(), envWith(db)))!
    const preRebuildEtag = first.headers.get("ETag")!

    // Sanity: the tag round-trips to a 304 before the rebuild.
    const cached = (await handleCellsReadRequest(fullReq(preRebuildEtag), envWith(db)))!
    expect(cached.status).toBe(304)

    await rebuild(db)

    // Post-rebuild the same tag must MISS (200 + fresh tag), or conditional
    // readers keep their pre-rebuild rows.
    const after = (await handleCellsReadRequest(fullReq(preRebuildEtag), envWith(db)))!
    expect(after.status).toBe(200)
    expect(after.headers.get("ETag")).not.toBe(preRebuildEtag)
  })

  it("a project that was never rebuilt (no counter row) behaves as before", async () => {
    // No project_seq_counters row exists for proj-a (raw seeds bypass the
    // allocator) — the rebuilt_seq lookup must coalesce to 0 and leave the
    // delta path untouched.
    const { db } = await makeTestDb({
      cells: [makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" })],
      events: [makeEvent({ id: "e1", server_seq: 1, cell_id: "c1" })],
    } as unknown as Seed)
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const res = (await handleCellsReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells?since=1", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    const body = (await res.json()) as { delta?: boolean; resync?: boolean; maxServerSeq: number }
    expect(body.resync).toBeUndefined()
    expect(body.delta).toBe(true)
    expect(body.maxServerSeq).toBe(1)
  })
})
