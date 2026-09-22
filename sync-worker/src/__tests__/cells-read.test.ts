import { describe, it, expect, vi } from "vitest"
import { handleCellsReadRequest, type CellsReadEnv } from "../events/cells-read-route"
import { handleRebuildProjectionRequest } from "../events/rebuild"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
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
  it("rejects more than 100 targeted cell ids instead of silently truncating them", async () => {
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const ids = Array.from({ length: 101 }, (_, index) => `c${index}`).join(",")
    const req = new Request(
      `https://w/api/v1/projects/proj-a/files/file-x/cells?cellIds=${ids}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )

    const res = (await handleCellsReadRequest(req, envWith(db)))!

    expect(res.status).toBe(400)
    expect(await res.text()).toContain("maximum is 100")
  })

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

  it("keeps an orphaned sub-chain contiguous behind its orphan root (AQU-931)", async () => {
    // c2's anchor points at a retracted cell ("gone"). The old flat-append
    // would scatter c2/c3/c4 in event_id order (c3, c4, c2 here); the orphan
    // root must instead be promoted with its descendants walked behind it.
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e5" }),
        makeCell({ cell_id: "c2", anchor_cell_id: "gone", event_id: "e9" }),
        makeCell({ cell_id: "c3", anchor_cell_id: "c2", event_id: "e2" }),
        makeCell({ cell_id: "c4", anchor_cell_id: "c3", event_id: "e3" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string }> }
    expect(body.cells.map((c) => c.cellId)).toEqual(["c1", "c2", "c3", "c4"])
  })

  it("orders multiple orphan roots by event_id, each with its own sub-chain (AQU-931)", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "b1", anchor_cell_id: "gone-b", event_id: "e7" }),
        makeCell({ cell_id: "b2", anchor_cell_id: "b1", event_id: "e1" }),
        makeCell({ cell_id: "a1", anchor_cell_id: "gone-a", event_id: "e4" }),
        makeCell({ cell_id: "a2", anchor_cell_id: "a1", event_id: "e8" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string }> }
    // Roots by event_id: a1 (e4) before b1 (e7); each drags its chain along.
    expect(body.cells.map((c) => c.cellId)).toEqual(["a1", "a2", "b1", "b2"])
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

  it("returns provenance only for an untouched AI draft", async () => {
    const aiDraft = {
      model: "gpt-5.6-luna",
      provider: "frontier",
      promptVersion: "translation-draft-v2",
      exampleIds: ["example-1"],
      generatedAt: 123,
      mode: "read",
      projectState: {
        sourceLanguage: "en", targetLanguage: "es", approvedExampleCount: 1,
        evidenceCoverage: 0.5, evidenceWeight: 0.2,
      },
    }
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "ai", event_id: "ev-ai", anchor_cell_id: null, ai_drafted: 1, ai_draft: aiDraft }),
        makeCell({ cell_id: "human", event_id: "ev-human", anchor_cell_id: "ai", ai_drafted: 0, ai_draft: aiDraft }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string; aiDraft: unknown }> }
    expect(body.cells.find((cell) => cell.cellId === "ai")?.aiDraft).toEqual(aiDraft)
    expect(body.cells.find((cell) => cell.cellId === "human")?.aiDraft).toBeNull()
  })

  it("AQU-538: lane filters target rows to the requested lane; source rows are always included", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "s1", side: "source", anchor_cell_id: null, event_id: "es1", value: "src-1" }),
        makeCell({
          cell_id: "t1", side: "target", anchor_cell_id: null, event_id: "et1-default", value: "default-lane",
          target_lang: "",
        }),
        makeCell({
          cell_id: "t1", side: "target", anchor_cell_id: null, event_id: "et1-fr", value: "fr-lane",
          target_lang: "fr",
        }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?lane=fr",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cells: Array<{ side: string; value: string; targetLang: string }>
    }
    // Source row always present; only the fr-lane target row is present.
    expect(body.cells.map((c) => c.value).sort()).toEqual(["fr-lane", "src-1"])
    const target = body.cells.find((c) => c.side === "target")!
    expect(target.targetLang).toBe("fr")
  })

  it("AQU-538: absent lane param returns all lanes (unchanged behavior)", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({
          cell_id: "t1", side: "target", anchor_cell_id: null, event_id: "et1-default", value: "default-lane",
          target_lang: "",
        }),
        makeCell({
          cell_id: "t1", side: "target", anchor_cell_id: null, event_id: "et1-fr", value: "fr-lane",
          target_lang: "fr",
        }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ value: string }> }
    expect(body.cells.map((c) => c.value).sort()).toEqual(["default-lane", "fr-lane"])
  })

  it("rejects a lane value longer than 64 characters with 400", async () => {
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const longLane = "x".repeat(65)
    const req = new Request(
      `https://w/api/v1/projects/proj-a/files/file-x/cells?lane=${longLane}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("round-trips source.cell.create payload.metadata through the JSONB column to the read route (OBS parity)", async () => {
    // Drive the REAL projection write path (source.cell.create → cells.metadata
    // JSONB) against real Postgres, then read it back through the route. This is
    // the whole point of the metadata bucket: an extensible per-cell object that
    // OBS populates with frame images and survives write → JSONB → read intact.
    const { db } = await makeTestDb({})
    const attachments = [{ type: "image", url: "https://x/01.jpg", alt: "frame 1" }]
    const createEvent = {
      id: "ev-obs-1",
      schemaVersion: 1,
      projectId: "proj-a",
      fileId: "file-x",
      cellId: "obs-c1",
      parentId: null,
      kind: "source.cell.create",
      author: "importer",
      payload: {
        cellId: "obs-c1",
        anchorCellId: null,
        value: "Once upon a time…",
        metadata: { attachments },
      },
      clientTs: 1,
      serverTs: 1700000000000,
    } as unknown as PersistedEvent

    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, createEvent, stmts)
    await db.batch(stmts)

    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cells: Array<{ cellId: string; metadata: { attachments?: unknown } | null }>
    }
    expect(body.cells).toHaveLength(1)
    // The bucket round-trips as a parsed object (not a JSON string), exactly
    // matching what was written on the create event.
    expect(body.cells[0].cellId).toBe("obs-c1")
    expect(body.cells[0].metadata).toEqual({ attachments })
  })

  it("returns null metadata for a cell created without a metadata payload", async () => {
    // Absent metadata must bind NULL, not 'null'/'{}' — the client distinguishes
    // "no attachments" (null) from an empty bucket.
    const { db } = await makeTestDb({})
    const createEvent = {
      id: "ev-plain-1",
      schemaVersion: 1,
      projectId: "proj-a",
      fileId: "file-x",
      cellId: "plain-c1",
      parentId: null,
      kind: "source.cell.create",
      author: "importer",
      payload: { cellId: "plain-c1", anchorCellId: null, value: "no images here" },
      clientTs: 1,
      serverTs: 1700000000000,
    } as unknown as PersistedEvent

    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(db, createEvent, stmts)
    await db.batch(stmts)

    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ metadata: unknown }> }
    expect(body.cells).toHaveLength(1)
    expect(body.cells[0].metadata).toBeNull()
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
  // ETag shape is "<fileId>:<epoch>:<rebuiltSeq>:<maxSeq>" (audit B5 +
  // AQU-943); these seeds have no project_seq_counters row at all, so both
  // epoch and rebuiltSeq are 0.
  it("sets ETag \"<fileId>:<epoch>:<rebuiltSeq>:<maxSeq>\" on full reads and includes maxServerSeq in the body", async () => {
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
    expect(res.headers.get("ETag")).toBe('"file-x:0:0:7"')
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
      headers: { Authorization: `Bearer ${token}`, "If-None-Match": '"file-x:0:0:5"' },
    })
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(304)
    expect(res.headers.get("ETag")).toBe('"file-x:0:0:5"')
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
      headers: { Authorization: `Bearer ${token}`, "If-None-Match": '"file-x:0:0:5"' },
    })
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    expect(res.headers.get("ETag")).toBe('"file-x:0:0:6"')
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

  it("AQU-538: delta reads honor the lane filter; source rows are always included", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", side: "source", anchor_cell_id: null, event_id: "es1", value: "src" }),
        makeCell({
          cell_id: "c1", side: "target", anchor_cell_id: null, event_id: "et1-default", value: "default-lane",
          target_lang: "",
        }),
        makeCell({
          cell_id: "c1", side: "target", anchor_cell_id: null, event_id: "et1-fr", value: "fr-lane",
          target_lang: "fr",
        }),
      ],
      events: [makeEvent({ id: "et1", server_seq: 9, cell_id: "c1" })],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?since=0&lane=fr",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as {
      changedCellIds: string[]
      cells: Array<{ side: string; value: string }>
    }
    expect(body.changedCellIds).toEqual(["c1"])
    // Source row for c1 plus only the fr-lane target row — not the default lane one.
    expect(body.cells.map((c) => c.value).sort()).toEqual(["fr-lane", "src"])
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

// ── Project incarnation (AQU-943) ───────────────────────────────────────────
//
// Deleting every row for a project — including its project_seq_counters row —
// and re-migrating it recreates the project under the SAME deterministic
// project/file ids, but the seq allocator restarts near 1. A browser that
// viewed the OLD incarnation still holds `?since=` cursors from the old
// (higher) seq range, so every delta reports "nothing newer than your cursor"
// and the client renders its pre-wipe cache forever — including a scrambled
// mid-ingest snapshot. Neither the ETag nor the `since < rebuilt_seq` gate
// could see the wipe: neither embedded any notion of the project's
// incarnation.
//
// project_seq_counters.project_epoch is that notion. Two independent gates use
// it (see cells-read-route.ts): an explicit `?epoch=` mismatch, and a cursor
// that sits above everything the project can currently advertise.

describe("project incarnation (AQU-943)", () => {
  /** The live incarnation: a counter row (epoch + last_seq) and one event. */
  async function seedIncarnation(
    db: AquillaDb,
    opts: { epoch: number; serverSeq: number; value: string },
  ): Promise<void> {
    await db.prepare("DELETE FROM events WHERE project_id = ?").bind("proj-a").run()
    await db.prepare("DELETE FROM cells WHERE project_id = ?").bind("proj-a").run()
    await db.prepare("DELETE FROM project_seq_counters WHERE project_id = ?").bind("proj-a").run()
    await db
      .prepare(
        "INSERT INTO project_seq_counters (project_id, last_seq, rebuilt_seq, project_epoch) VALUES (?, ?, 0, ?)",
      )
      .bind("proj-a", opts.serverSeq, opts.epoch)
      .run()
    await db
      .prepare(
        "INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(`ev-${opts.epoch}`, 1, "proj-a", "file-x", "c1", "target.cell.commit", "alice", "{}", 1, 1, opts.serverSeq)
      .run()
    await db
      .prepare(
        "INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, anchor_cell_id, event_id, last_editor, last_edit_at, validated, word_count) VALUES (?, ?, ?, 'target', '', ?, NULL, ?, 'alice', 1, 0, 1)",
      )
      .bind("proj-a", "file-x", "c1", opts.value, `ev-${opts.epoch}`)
      .run()
  }

  function deltaReq(token: string, since: number, epoch?: number): Request {
    const suffix = epoch === undefined ? "" : `&epoch=${epoch}`
    return new Request(
      `https://w/api/v1/projects/proj-a/files/file-x/cells?since=${since}${suffix}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
  }

  it("a cursor minted against a previous incarnation is told to resync, even when the new seq range is HIGHER", async () => {
    // The epoch is the only signal that survives here: the re-migration
    // produced MORE events than the wiped one, so the old cursor still sits
    // inside the new seq range and the delta would look perfectly valid while
    // silently skipping every re-created cell below it.
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    await seedIncarnation(db, { epoch: 1_000, serverSeq: 50, value: "old-incarnation" })
    const warm = (await handleCellsReadRequest(deltaReq(token, 50, 1_000), envWith(db)))!
    const warmBody = (await warm.json()) as { delta?: boolean; projectEpoch?: number }
    expect(warmBody.delta).toBe(true)
    expect(warmBody.projectEpoch).toBe(1_000)

    // Wipe + re-migrate: same ids, new counter row, new (larger) history.
    await seedIncarnation(db, { epoch: 2_000, serverSeq: 900, value: "new-incarnation" })

    const after = (await handleCellsReadRequest(deltaReq(token, 50, 1_000), envWith(db)))!
    const afterBody = (await after.json()) as {
      resync?: boolean
      delta?: boolean
      projectEpoch?: number
    }
    expect(afterBody.resync).toBe(true)
    expect(afterBody.delta).toBeUndefined()
    expect(afterBody.projectEpoch).toBe(2_000)
  })

  it("a cursor ABOVE the re-created project's whole history resyncs even without ?epoch=", async () => {
    // The observed live failure (old max 129,108; re-migrated max 62,932) and
    // the only rescue available to a client that predates the epoch: a cursor
    // can only outrun the log if the allocator restarted.
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    await seedIncarnation(db, { epoch: 1_000, serverSeq: 129_108, value: "old-incarnation" })
    await seedIncarnation(db, { epoch: 2_000, serverSeq: 62_932, value: "new-incarnation" })

    const res = (await handleCellsReadRequest(deltaReq(token, 129_108), envWith(db)))!
    const body = (await res.json()) as { resync?: boolean; delta?: boolean; maxServerSeq: number }
    expect(body.resync).toBe(true)
    expect(body.maxServerSeq).toBe(62_932)

    // …and the resync converges: the full refetch shows the new incarnation's
    // rows and hands back a cursor whose next delta is a normal empty one, not
    // another resync (no loop).
    const full = (await handleCellsReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells?side=target", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    const fullBody = (await full.json()) as {
      cells: Array<{ value: string }>
      maxServerSeq: number
      projectEpoch: number
    }
    expect(fullBody.cells.map((c) => c.value)).toEqual(["new-incarnation"])
    expect(fullBody.projectEpoch).toBe(2_000)

    const next = (await handleCellsReadRequest(
      deltaReq(token, fullBody.maxServerSeq, fullBody.projectEpoch),
      envWith(db),
    ))!
    const nextBody = (await next.json()) as {
      delta?: boolean
      resync?: boolean
      changedCellIds?: string[]
    }
    expect(nextBody.resync).toBeUndefined()
    expect(nextBody.delta).toBe(true)
    expect(nextBody.changedCellIds).toEqual([])
  })

  it("the ETag misses across a re-creation whose MAX(server_seq) went BACKWARDS", async () => {
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const fullReq = (etag?: string) =>
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
      })

    await seedIncarnation(db, { epoch: 1_000, serverSeq: 129_108, value: "old-incarnation" })
    const first = (await handleCellsReadRequest(fullReq(), envWith(db)))!
    const oldEtag = first.headers.get("ETag")!
    expect((await handleCellsReadRequest(fullReq(oldEtag), envWith(db)))!.status).toBe(304)

    await seedIncarnation(db, { epoch: 2_000, serverSeq: 62_932, value: "new-incarnation" })

    const after = (await handleCellsReadRequest(fullReq(oldEtag), envWith(db)))!
    expect(after.status).toBe(200)
    expect(after.headers.get("ETag")).not.toBe(oldEtag)
  })

  it("a live project still deltas and 304s — a matching epoch costs no extra refetch", async () => {
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    await seedIncarnation(db, { epoch: 1_000, serverSeq: 50, value: "live" })

    const delta = (await handleCellsReadRequest(deltaReq(token, 50, 1_000), envWith(db)))!
    const deltaBody = (await delta.json()) as {
      delta?: boolean
      resync?: boolean
      changedCellIds?: string[]
    }
    expect(deltaBody.resync).toBeUndefined()
    expect(deltaBody.delta).toBe(true)
    expect(deltaBody.changedCellIds).toEqual([])

    const full = (await handleCellsReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    const etag = full.headers.get("ETag")!
    const conditional = (await handleCellsReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells", {
        headers: { Authorization: `Bearer ${token}`, "If-None-Match": etag },
      }),
      envWith(db),
    ))!
    expect(conditional.status).toBe(304)
  })

  it("the interim operator remedy — bumping last_seq/rebuilt_seq past the old horizon — still forces the resync", async () => {
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    await seedIncarnation(db, { epoch: 1_000, serverSeq: 62_932, value: "new-incarnation" })
    await db
      .prepare("UPDATE project_seq_counters SET last_seq = ?, rebuilt_seq = ? WHERE project_id = ?")
      .bind(130_000, 130_000, "proj-a")
      .run()

    // The stale cursor is now BELOW rebuilt_seq, so the audit-B5 gate fires —
    // the epoch gates must not have displaced it.
    const res = (await handleCellsReadRequest(deltaReq(token, 129_108, 1_000), envWith(db)))!
    const body = (await res.json()) as { resync?: boolean; maxServerSeq: number }
    expect(body.resync).toBe(true)
    expect(body.maxServerSeq).toBe(130_000)
  })

  it("rejects a non-numeric epoch instead of silently ignoring it", async () => {
    const { db } = await makeTestDb({})
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const res = (await handleCellsReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/file-x/cells?since=1&epoch=abc", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("invalid epoch")
  })
})

// ── AQU-1160: ordered-id chain cache ────────────────────────────────────────
//
// Cell page reads used to materialize + walk every row on EVERY page. These
// tests verify the fix's two obligations: (1) a page past the first one for
// an unchanged file touches a bounded number of rows, independent of file
// size (AC1); (2) the cached path returns byte-identical cells/order to the
// uncached full-materialization walk on the same fixtures the ordering-oracle
// tests above already cover — ties, orphans, multi-root, lanes, both sides
// (AC2). It never changes cellIds=/since= behavior (untouched code paths).

/** Wraps `db` so every `.all()` row count issued through it is recorded in
 *  `counts`, in call order — lets a test assert a request touched a bounded
 *  number of rows without depending on internal query shapes. */
function countingEnv(db: AquillaDb): { env: CellsReadEnv; counts: number[] } {
  const counts: number[] = []
  // Monkey-patches `db.prepare` in place. (The chain cache is module-level
  // and keyed on projectId + ETag, so instance identity no longer matters —
  // see the cross-instance test below.)
  const originalPrepare = db.prepare.bind(db)
  db.prepare = (sql: string) => {
    let bound = originalPrepare(sql)
    const wrapper = {
      bind(...args: unknown[]) {
        bound = bound.bind(...args)
        return wrapper
      },
      async all<T>() {
        const res = await bound.all<T>()
        counts.push(res.results.length)
        return res
      },
      async run<T>() {
        return bound.run<T>()
      },
      async first<T>(colName?: string) {
        return bound.first<T>(colName)
      },
      async raw<T>() {
        return bound.raw<T>()
      },
    }
    return wrapper
  }
  return { env: { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }, counts }
}

/** A single-side (`target`) linear chain of `n` cells, head → tail, so
 *  ordering is unambiguous and easy to assert against by index. */
function makeLinearChain(n: number): CellRow[] {
  const cells: CellRow[] = []
  let prev: string | null = null
  for (let i = 0; i < n; i++) {
    const id = `lc${i.toString().padStart(5, "0")}`
    cells.push(makeCell({ cell_id: id, anchor_cell_id: prev, event_id: `e${id}` }))
    prev = id
  }
  return cells
}

describe("AQU-1160: chain-order cache", () => {
  it("AC1: a page past the first touches only that page's rows, independent of file size", async () => {
    const N = 500
    const cells = makeLinearChain(N)
    const { db } = await makeTestDb({ cells })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const limit = 20

    // Page 1: cache miss — pays the full-file cost once (unchanged from the
    // pre-AQU-1160 behavior; nothing to bound here).
    const firstReq = new Request(
      `https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=${limit}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const firstRes = (await handleCellsReadRequest(firstReq, envWith(db)))!
    const firstBody = (await firstRes.json()) as {
      cells: Array<{ cellId: string }>
      nextCursor: string | null
    }
    expect(firstBody.cells.map((c) => c.cellId)).toEqual(
      Array.from({ length: limit }, (_, i) => `lc${i.toString().padStart(5, "0")}`),
    )

    // Page 5 (deep into the file): cache hit — must NOT re-touch anything
    // close to N rows. Walk cursors forward through pages 2..5 first (each
    // still against the same unchanged ETag, so all are hits after page 1).
    let cursor = firstBody.nextCursor
    let lastBody: { cells: Array<{ cellId: string }>; nextCursor: string | null } = firstBody
    const { env: countedEnv, counts } = countingEnv(db)
    for (let page = 2; page <= 5; page++) {
      const req = new Request(
        `https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=${limit}&cursor=${encodeURIComponent(cursor!)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const res = (await handleCellsReadRequest(req, countedEnv))!
      lastBody = (await res.json()) as { cells: Array<{ cellId: string }>; nextCursor: string | null }
      cursor = lastBody.nextCursor
    }
    expect(lastBody.cells.map((c) => c.cellId)).toEqual(
      Array.from({ length: limit }, (_, i) => `lc${(4 * limit + i).toString().padStart(5, "0")}`),
    )
    // Every one of the 4 cache-hit requests above issued only bounded,
    // page-sized queries (watermark point-reads + the `IN (...)` page fetch)
    // — never anything close to N=500. This is the AC1 evidence: total rows
    // read across 4 pages stays a small multiple of `limit`, not of file size.
    const totalRowsRead = counts.reduce((a, b) => a + b, 0)
    expect(totalRowsRead).toBeLessThan(N)
    expect(totalRowsRead).toBeLessThan(limit * 4 * 3) // generous slack for watermark rows
    // eslint-disable-next-line no-console
    console.log(
      `[AQU-1160 test evidence] file size=${N} cells; 4 cache-hit pages of ${limit} touched ${totalRowsRead} total rows (query counts: ${JSON.stringify(counts)})`,
    )
  })

  it("hits across distinct AquillaDb instances — production builds a fresh db per request (perf/cells-chain-cache)", async () => {
    // sync-worker/src/index.ts constructs a brand-new PostgresDb via
    // makePostgres() for EVERY request. A cache keyed on db-instance
    // identity therefore never hits in production: each page re-runs the
    // full-file SELECT. Model that here with two wrapper objects over the
    // same underlying store — distinct identities, identical data.
    const N = 300
    const { db } = await makeTestDb({ cells: makeLinearChain(N) })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const limit = 10

    /** A NEW object per call (never the same identity twice), recording the
     *  row count of every `.all()` it serves. */
    const freshDb = (counts: number[]): AquillaDb => ({
      prepare(sql: string) {
        let bound = db.prepare(sql)
        const wrapper = {
          bind(...args: unknown[]) {
            bound = bound.bind(...args)
            return wrapper
          },
          async all<T>() {
            const res = await bound.all<T>()
            counts.push(res.results.length)
            return res
          },
          async run<T>() {
            return bound.run<T>()
          },
          async first<T>(colName?: string) {
            return bound.first<T>(colName)
          },
          async raw<T>() {
            return bound.raw<T>()
          },
        }
        return wrapper
      },
    }) as unknown as AquillaDb

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const logged = (marker: string) =>
      logSpy.mock.calls.filter(([line]) => String(line).includes(marker)).length

    const firstCounts: number[] = []
    const firstRes = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: freshDb(firstCounts), SYNC_SECRET_KEY: SECRET },
    ))!
    const firstBody = (await firstRes.json()) as { cells: Array<{ cellId: string }>; nextCursor: string }
    // Page 1 is the unavoidable miss: it paid the full-file cost.
    expect(Math.max(...firstCounts)).toBe(N)
    expect(logged("[cells-read] chain-cache miss")).toBe(1)
    expect(logged("[cells-read] chain-cache hit")).toBe(0)

    const secondCounts: number[] = []
    const secondRes = (await handleCellsReadRequest(
      new Request(
        `https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=${limit}&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      { AQUILLA_PG: freshDb(secondCounts), SYNC_SECRET_KEY: SECRET },
    ))!
    const secondBody = (await secondRes.json()) as { cells: Array<{ cellId: string }>; total: number }
    expect(secondBody.cells.map((c) => c.cellId)).toEqual(
      Array.from({ length: limit }, (_, i) => `lc${(limit + i).toString().padStart(5, "0")}`),
    )
    expect(secondBody.total).toBe(N)
    // Page 2 came through a DIFFERENT db instance and must still be a cache
    // hit: no query on this request may return anything near the whole file.
    expect(Math.max(...secondCounts)).toBeLessThanOrEqual(limit)
    // ...and it says so at the same verbosity the miss path logs at.
    expect(logged("[cells-read] chain-cache miss")).toBe(1)
    expect(logged("[cells-read] chain-cache hit")).toBe(1)
    logSpy.mockRestore()
  })

  it("AC2: cache-hit pages reproduce the exact anchor-chain order the uncached walk produces (ties + orphans + multi-root)", async () => {
    // Same shape as the two AQU-931 oracle tests above, concatenated into one
    // file: a sibling tie, an orphaned sub-chain, and two orphan roots.
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "head", anchor_cell_id: null, event_id: "ev0" }),
        makeCell({ cell_id: "second", anchor_cell_id: "head", event_id: "ev2" }),
        makeCell({ cell_id: "first", anchor_cell_id: "head", event_id: "ev1" }),
        makeCell({ cell_id: "o2", anchor_cell_id: "gone", event_id: "e9" }),
        makeCell({ cell_id: "o3", anchor_cell_id: "o2", event_id: "e2" }),
        makeCell({ cell_id: "o4", anchor_cell_id: "o3", event_id: "e3" }),
        makeCell({ cell_id: "b1", anchor_cell_id: "gone-b", event_id: "e7" }),
        makeCell({ cell_id: "b2", anchor_cell_id: "b1", event_id: "e1" }),
        makeCell({ cell_id: "a1", anchor_cell_id: "gone-a", event_id: "e4" }),
        makeCell({ cell_id: "a2", anchor_cell_id: "a1", event_id: "e8" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    // Uncached oracle: one big unpaginated read (limit above the row count).
    const oracleReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=100",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const oracleBody = (await (await handleCellsReadRequest(oracleReq, envWith(db)))!.json()) as {
      cells: Array<{ cellId: string }>
    }
    const oracleOrder = oracleBody.cells.map((c) => c.cellId)
    expect(oracleOrder).toEqual([
      "head", "first", "second", "a1", "a2", "b1", "b2", "o2", "o3", "o4",
    ])

    // Now walk it page by page with a tiny limit so every page after the
    // first is a cache hit, and confirm the concatenated pages equal the
    // oracle order exactly — no dropped, duplicated, or reordered rows.
    const { env: countedEnv } = countingEnv(db)
    let cursor: string | null = null
    const pagedOrder: string[] = []
    for (let i = 0; i < 20; i++) {
      const url = cursor
        ? `https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=3&cursor=${encodeURIComponent(cursor)}`
        : "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=3"
      const req = new Request(url, { headers: { Authorization: `Bearer ${token}` } })
      const body = (await (await handleCellsReadRequest(req, countedEnv))!.json()) as {
        cells: Array<{ cellId: string }>
        nextCursor: string | null
      }
      pagedOrder.push(...body.cells.map((c) => c.cellId))
      cursor = body.nextCursor
      if (!cursor) break
    }
    expect(pagedOrder).toEqual(oracleOrder)
  })

  it("invalidates on a new event (ETag change) instead of serving a stale ordering", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" }),
        makeCell({ cell_id: "c2", anchor_cell_id: "c1", event_id: "e2" }),
      ],
      events: [makeEvent({ id: "e1", server_seq: 1, cell_id: "c1" })],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })

    // Warm the cache at limit=1 (page 1 only — c1).
    const firstReq = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=1",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const firstRes = (await handleCellsReadRequest(firstReq, envWith(db)))!
    const firstBody = (await firstRes.json()) as { cells: Array<{ cellId: string }>; nextCursor: string }
    expect(firstBody.cells.map((c) => c.cellId)).toEqual(["c1"])
    const cursor = firstBody.nextCursor

    // A new cell lands BEFORE c1 in chain order (new event → new ETag).
    await db
      .prepare(
        "INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES (?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
      )
      .bind("e0", "proj-a", "file-x", "c0", "target.cell.create", "alice", "{}", 1700000000001, 1700000000001, 2)
      .run()
    await db
      .prepare(
        "INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, value_html, type, canonical_ref, anchor_cell_id, event_id, source_event_id, last_editor, last_edit_at, validated, word_count, content_hash) VALUES (?, ?, ?, 'target', '', ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?, 0, 1, NULL)",
      )
      .bind("proj-a", "file-x", "c0", "v0", "e0", "alice", 1700000000001)
      .run()

    // Reusing the OLD cursor against the NEW ETag must not serve a page built
    // from the stale (pre-c0) ordering — the offset now means something
    // different in the new chain, exactly like the pre-cache full-recompute
    // behavior (this route has never validated a cursor's offset against the
    // version it was minted under; the cache must not make that worse).
    const secondReq = new Request(
      `https://w/api/v1/projects/proj-a/files/file-x/cells?side=target&limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const secondRes = (await handleCellsReadRequest(secondReq, envWith(db)))!
    const secondBody = (await secondRes.json()) as { cells: Array<{ cellId: string }> }
    // New chain order is c0 → c1 → c2; offset 1 in the fresh walk is c1 —
    // same as before c0 landed, proving the cache recomputed rather than
    // reusing a stale id list (a stale reuse would return c2 here).
    expect(secondBody.cells.map((c) => c.cellId)).toEqual(["c1"])
  })

  it("does not apply to the cellIds= fast path (unpaginated, caller-order, unaffected by the cache)", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "c1", anchor_cell_id: null, event_id: "e1" }),
        makeCell({ cell_id: "c2", anchor_cell_id: "c1", event_id: "e2" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/files/file-x/cells?cellIds=c2,c1",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleCellsReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { cells: Array<{ cellId: string }>; maxServerSeq: number | null }
    // Caller-requested order (c2, c1), not chain order — and no watermark
    // (maxServerSeq stays null), exactly as before this change.
    expect(body.cells.map((c) => c.cellId)).toEqual(["c2", "c1"])
    expect(body.maxServerSeq).toBeNull()
  })
})

// The actual HTTP producer feeds the SPA's streaming consumer, not a synthetic
// page fixture: this pins the contract that a visible row can be edited safely.
describe("AQU-1328 complete source/target row pages", () => {
  it("keeps all lanes together at cold and cached boundaries, with empty and target-only rows", async () => {
    const { streamFileCells } = await import("../../../src/lib/sync/cells-read")
    const db = await makeTestDb({ cells: [
      makeCell({ cell_id: "a", side: "source", anchor_cell_id: null, event_id: "s-a", value: "Source A" }),
      makeCell({ cell_id: "b", side: "source", anchor_cell_id: "a", event_id: "s-b", value: "Source B" }),
      makeCell({ cell_id: "c", side: "source", anchor_cell_id: "b", event_id: "s-c", value: "Source C" }),
      makeCell({ cell_id: "a", anchor_cell_id: null, event_id: "t-a", value: "Target A" }),
      makeCell({ cell_id: "a", target_lang: "es", anchor_cell_id: null, event_id: "es-a", value: "Destino A" }),
      makeCell({ cell_id: "c", anchor_cell_id: "a", event_id: "t-c", value: "Target C" }),
      makeCell({ cell_id: "c", target_lang: "es", anchor_cell_id: "a", event_id: "es-c", value: "Destino C" }),
      makeCell({ cell_id: "orphan", anchor_cell_id: "c", event_id: "t-o", value: "Target only" }),
    ] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const request = async (url: string) => (await handleCellsReadRequest(
      new Request(url, { headers: { Authorization: `Bearer ${token}` } }), envWith(db.db),
    ))!
    try {
      // Prime the legacy ordering: paired pages must use a separate cache key.
      const legacy = await request("https://w/api/v1/projects/proj-a/files/file-x/cells?limit=2")
      expect((await legacy.json() as { cells: { cellId: string }[] }).cells.map(r => r.cellId)).toEqual(["a", "b"])
      vi.stubGlobal("fetch", vi.fn(async (input: string) => {
        const url = new URL(input)
        expect(url.searchParams.get("paired")).toBe("1")
        url.searchParams.set("limit", "2") // Cut directly through a multi-lane row.
        return request(url.toString())
      }))
      const pages: Array<Array<{ cellId: string; side: string; value: string }>> = []
      await streamFileCells("proj-a", "file-x", token, (rows) => { pages.push(rows) }, undefined, undefined, undefined, true)
      expect(pages.map(rows => rows.map(r => [r.cellId, r.side, r.value]))).toEqual([
        [["a", "source", "Source A"], ["a", "target", "Target A"], ["a", "target", "Destino A"]],
        [["b", "source", "Source B"], ["c", "source", "Source C"], ["c", "target", "Target C"], ["c", "target", "Destino C"]],
        [["orphan", "target", "Target only"]],
      ])
      // An offset shifted inside a group must re-deliver the complete group,
      // on both a cache hit and the cold fallback.
      const shifted = `https://w/api/v1/projects/proj-a/files/file-x/cells?paired=1&limit=1&cursor=${encodeURIComponent(btoa(JSON.stringify({ offset: 1 })))}`
      for (const cold of [false, true]) {
        if (cold) {
          const { resetChainCacheForTests } = await import("../events/cells-read-route")
          resetChainCacheForTests()
        }
        const response = await request(shifted)
        const body = await response.json() as { cells: { cellId: string }[]; completeRows: boolean }
        expect(body.completeRows).toBe(true)
        expect(body.cells.map(r => r.cellId)).toEqual(["a", "a", "a"])
      }
    } finally {
      vi.unstubAllGlobals()
      await db.close()
    }
  })
})

it("preserves every row in anchor order when follow-up pages grow from 500 to 2000", async () => {
  const expected = makeLinearChain(2503)
  // Exercise array-literal quoting on a follow-up page, including IDs that
  // resemble PostgreSQL array syntax. IDs are data, never SQL fragments.
  expected[500].cell_id = 'id"with\\slashes,{NULL}'
  expected[501].anchor_cell_id = expected[500].cell_id
  const { db } = await makeTestDb({ cells: expected })
  const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
  const ids: string[] = []
  let cursor: string | null = null
  for (const limit of [500, 2000, 2000]) {
    const url = new URL("https://w/api/v1/projects/proj-a/files/file-x/cells")
    url.searchParams.set("side", "target")
    url.searchParams.set("limit", String(limit))
    if (cursor) url.searchParams.set("cursor", cursor)
    const response = (await handleCellsReadRequest(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), envWith(db)))!
    expect(response.status).toBe(200)
    const page = await response.json() as { cells: { cellId: string }[]; total: number; nextCursor: string | null }
    expect(page.total).toBe(2503)
    ids.push(...page.cells.map(c => c.cellId))
    cursor = page.nextCursor
  }
  expect(cursor).toBeNull()
  expect(ids).toEqual(expected.map(c => c.cell_id))
  expect(new Set(ids).size).toBe(2503)
})

it("reads narrow ordering on a cold page and keeps intervening edits visible to delta sync", async () => {
  const { db } = await makeTestDb({
    cells: makeLinearChain(4),
    events: [makeEvent({ id: "initial", server_seq: 1, cell_id: "lc00000" })],
  })
  const prepare = db.prepare.bind(db)
  let orderingRows: Record<string, unknown>[] = []
  let changed = false
  db.prepare = (sql: string) => {
    const statement = prepare(sql)
    if (!sql.startsWith("SELECT cell_id, side, target_lang, anchor_cell_id, event_id FROM cells")) return statement
    const bind = statement.bind.bind(statement)
    statement.bind = (...args: unknown[]) => {
      const bound = bind(...args)
      const all = bound.all.bind(bound)
      bound.all = async <T>() => {
        const result = await all<T>()
        orderingRows = result.results as Record<string, unknown>[]
        if (!changed) {
          changed = true
          await prepare("UPDATE cells SET value = ? WHERE project_id = ? AND file_id = ? AND cell_id = ?").bind("edited during read", "proj-a", "file-x", "lc00000").run()
          await prepare("INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES (?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)")
            .bind("concurrent", "proj-a", "file-x", "lc00000", "target.cell.commit", "alice", "{}", 1700000000001, 1700000000001, 2).run()
        }
        return result
      }
      return bound
    }
    return statement
  }
  const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
  const request = (query: string) => new Request(`https://w/api/v1/projects/proj-a/files/file-x/cells?${query}`, { headers: { Authorization: `Bearer ${token}` } })
  const response = (await handleCellsReadRequest(request("side=target&limit=1"), envWith(db)))!
  const page = await response.json() as { cells: { cellId: string; value: string }[]; maxServerSeq: number }
  expect(orderingRows).toHaveLength(4)
  expect(Object.keys(orderingRows[0]).sort()).toEqual(["anchor_cell_id", "cell_id", "event_id", "side", "target_lang"])
  expect(page.cells).toHaveLength(1)
  expect(page.cells[0].value).toBe("edited during read")
  expect(page.maxServerSeq).toBe(1)
  const delta = await (await handleCellsReadRequest(request("since=1&epoch=0"), envWith(db)))!.json() as { changedCellIds: string[]; cells: { value: string }[] }
  expect(delta.changedCellIds).toContain("lc00000")
  expect(delta.cells[0].value).toBe("edited during read")
})
