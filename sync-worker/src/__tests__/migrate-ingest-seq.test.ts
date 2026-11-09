// AQU-1005: migrate-ingest pre-allocates the whole batch's server_seqs in ONE
// counter bump instead of running the bump CTE inside every event INSERT —
// the old shape held the per-project seq-counter row lock for the entire
// pipelined transaction, queueing live editors behind bulk ingest for minutes.
// These tests pin the contracts the swap must preserve: per-project seqs stay
// unique and strictly above every pre-existing event, id-replays are dropped
// without duplicating rows, and the projection still lands.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { handleMigrateIngestRequest } from "../events/migrate-ingest-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { buildCellAudioEvents } from "../../../src/lib/migrate/audio-copy"
import { selectedAudioProjectionRepairEvent, type AudioImport } from "../../../src/lib/migrate/audio"
import { handleRebuildProjectionRequest } from "../events/rebuild"

const SECRET = "test-secret"
const PROJECT = "proj-mig"
const FILE = "file-mig"

let t: TestDb
beforeAll(async () => {
  t = await makeTestDb()
}, 120_000)
afterAll(async () => {
  await t.close()
})
beforeEach(async () => {
  await t.reset()
})

function env() {
  return { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }
}

interface IngestEventIn {
  id: string
  kind: string
  fileId?: string | null
  cellId?: string | null
  parentId?: string | null
  author: string
  clientTs: number
  payload: unknown
}

function ingestRequest(events: IngestEventIn[], opts: { eventsOnly?: boolean } = {}): Request {
  return new Request("https://sync.test/migrate/ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT, events, ...opts }),
  })
}

function cellCreate(id: string, cellId: string, value: string): IngestEventIn {
  return {
    id,
    kind: "source.cell.create",
    fileId: FILE,
    cellId,
    parentId: null,
    author: "legacy-user",
    clientTs: 1600000000000,
    payload: { cellId, value },
  }
}

async function eventSeqs(): Promise<Array<{ id: string; server_seq: number }>> {
  const r = await t.pg.query<{ id: string; server_seq: number }>(
    "SELECT id, server_seq FROM events WHERE project_id=$1 ORDER BY server_seq",
    [PROJECT],
  )
  return r.rows
}

describe("migrate-ingest seq pre-allocation (AQU-1005)", () => {
  it("repairs an audited missing selected-audio projection without deleting its old event or validation, and rebuilds identically", async () => {
    const cellId = "missing-projection"
    const take: AudioImport = {
      legacyAudioId: "trimmed", aquillaAudioId: "trimmed.webm", diskRelPath: ".project/attachments/files/trimmed.webm",
      slot: "recording", createdAt: 1600000000000,
      validatedBy: [{ username: "validator", creationTimestamp: 1600000001000, updatedTimestamp: 1600000001000, isDeleted: false }],
    }
    const opts = { projectId: PROJECT, fileId: FILE, fallbackAuthor: "legacy-import", fallbackTs: 1600000000000 }
    const original = buildCellAudioEvents(cellId, [take], take.aquillaAudioId, opts)
    expect((await handleMigrateIngestRequest(ingestRequest(original), env()))?.status).toBe(200)
    // Reproduce the live inconsistency: saved events + vote, absent audio row.
    await t.pg.query("DELETE FROM cell_audio")
    expect((await handleMigrateIngestRequest(ingestRequest(original), env()))?.status).toBe(200)
    expect((await t.pg.query("SELECT * FROM cell_audio")).rows).toHaveLength(0)
    const proof = { originalEventId: original[0].id, sourceOid: "a".repeat(64), sourceSelectedAudioId: take.legacyAudioId }
    for (const invalid of [{ ...proof, originalEventId: "wrong" }, { ...proof, sourceOid: "bad" }, { ...proof, sourceSelectedAudioId: "another" }]) {
      expect(() => selectedAudioProjectionRepairEvent(cellId, take, opts, invalid)).toThrow("Invalid selected audio projection repair proof")
    }
    const repair = selectedAudioProjectionRepairEvent(cellId, take, opts, proof)
    expect(repair.id).not.toBe(original[0].id)
    expect(selectedAudioProjectionRepairEvent(cellId, take, opts, proof)).toEqual(repair)
    const repaired = await handleMigrateIngestRequest(ingestRequest([repair]), env())
    expect(await repaired!.json()).toMatchObject({ accepted: 1, replayed: 0 })
    const after = (await t.pg.query("SELECT * FROM cell_audio")).rows
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ selected: 1, deleted: 0, validator_count: 1, event_id: original[0].id })
    expect((await t.pg.query("SELECT * FROM events WHERE id=$1", [original[0].id])).rows).toHaveLength(1)
    const retry = await handleMigrateIngestRequest(ingestRequest([repair]), env())
    expect(await retry!.json()).toMatchObject({ accepted: 0, replayed: 1 })
    await t.pg.query("DELETE FROM cell_audio")
    const rebuild = await handleRebuildProjectionRequest(new Request(`https://sync.test/admin/projects/${PROJECT}/rebuild-projection?fullReplay=1`, {
      method: "POST", headers: { Authorization: `Bearer ${SECRET}` },
    }), env())
    expect(rebuild?.status, await rebuild?.clone().text()).toBe(200)
    expect((await t.pg.query("SELECT * FROM cell_audio")).rows).toEqual(after)
    // Destination guards also run inside projection, after the offline audit:
    // app deletion/selection changes must win if they race the repair.
    for (const change of ["deleted", "purged-deletion", "cleared", "other-selected"] as const) {
      await t.reset()
      await handleMigrateIngestRequest(ingestRequest(original), env())
      const action: IngestEventIn = change === "other-selected"
        ? { ...original[0], id: "app-new", author: "app-user", payload: { audioId: "new.wav", url: "frontier-audio://new.wav", slot: "recording" } }
        : { ...original[0], id: "app-action", author: "app-user", kind: change === "cleared" ? "cell.audio.select" : "cell.audio.remove",
            payload: { audioId: change === "cleared" ? null : take.aquillaAudioId, slot: "recording" } }
      expect((await handleMigrateIngestRequest(ingestRequest([action]), env()))?.status).toBe(200)
      if (change !== "deleted") await t.pg.query("DELETE FROM cell_audio WHERE audio_id=$1", [take.aquillaAudioId])
      const beforeRepair = (await t.pg.query<Record<string, unknown>>("SELECT * FROM cell_audio ORDER BY audio_id")).rows
      expect((await handleMigrateIngestRequest(ingestRequest([repair]), env()))?.status).toBe(200)
      const rows = (await t.pg.query<Record<string, unknown>>("SELECT * FROM cell_audio ORDER BY audio_id")).rows
      for (const row of beforeRepair) expect(rows.find(x => x.audio_id === row.audio_id)).toEqual(row)
      const recovered = rows.find(x => x.audio_id === take.aquillaAudioId)
      if (change === "purged-deletion") expect(recovered).toBeUndefined()
      else expect(recovered).toMatchObject({ selected: 0, deleted: change === "deleted" ? 1 : 0 })
    }
  }, 120_000)

  it("recovers historical audio without changing selection or reviving an app-deleted take, including replay", async () => {
    const capability = await handleMigrateIngestRequest(new Request("https://sync.test/migrate/ingest", {
      headers: { Authorization: `Bearer ${SECRET}` },
    }), env())
    expect(await capability!.json()).toEqual({ capabilities: ["audio-history-attach-v1", "audio-projection-repair-v1"] })
    for (const state of ["selected", "none", "deleted"] as const) {
      await t.reset()
      const cellId = `audio-${state}`
      const ordinary: IngestEventIn = {
        id: `app-attach-${state}`, kind: "cell.audio.attach", fileId: FILE, cellId,
        author: "app-user", clientTs: 1700000000000,
        payload: { audioId: state === "deleted" ? "old.wav" : "current.wav", url: "frontier-audio://current.wav", slot: "recording" },
      }
      const seed = await handleMigrateIngestRequest(ingestRequest([ordinary]), env())
      expect(seed?.status).toBe(200)
      if (state !== "selected") {
        const action = await handleMigrateIngestRequest(ingestRequest([{
          ...ordinary, id: `app-${state}`, kind: state === "deleted" ? "cell.audio.remove" : "cell.audio.select",
          payload: { audioId: state === "deleted" ? "old.wav" : null, slot: "recording" },
        }]), env())
        expect(action?.status).toBe(200)
      }
      const before = (await t.pg.query<Record<string, unknown>>("SELECT * FROM cell_audio ORDER BY audio_id")).rows
      // Actual daemon producer -> actual ingest handler -> real Postgres projection.
      const recovery = buildCellAudioEvents(cellId, [{
        legacyAudioId: "old", aquillaAudioId: "old.wav", diskRelPath: ".project/attachments/files/old.wav",
        slot: "recording", createdBy: "original-author", createdAt: 1600000000000,
      }], null, { projectId: PROJECT, fileId: FILE, fallbackAuthor: "legacy-import", fallbackTs: 1800000000000, preserveUnselectedHistory: true })
      expect(recovery).toHaveLength(1)
      expect(recovery[0].payload).toMatchObject({ historyOnly: true })
      const response = await handleMigrateIngestRequest(ingestRequest(recovery), env())
      expect(response?.status).toBe(200)
      const after = (await t.pg.query<Record<string, unknown>>("SELECT * FROM cell_audio ORDER BY audio_id")).rows
      for (const row of before) expect(after.find(x => x.audio_id === row.audio_id)).toEqual(row)
      if (state !== "deleted") {
        expect(after.find(x => x.audio_id === "old.wav")).toMatchObject({ selected: 0, deleted: 0, created_by: "original-author", created_ts: 1600000000000 })
      }
      const replay = await handleMigrateIngestRequest(ingestRequest(recovery), env())
      expect(replay?.status).toBe(200)
      expect((await t.pg.query("SELECT * FROM cell_audio ORDER BY audio_id")).rows).toEqual(after)
      // Rebuild normally retains audio rows. Empty only this isolated fixture
      // too, to prove the saved payload recreates the same state from scratch.
      await t.pg.query("DELETE FROM cell_audio")
      const rebuild = await handleRebuildProjectionRequest(new Request(`https://sync.test/admin/projects/${PROJECT}/rebuild-projection?fullReplay=1`, {
        method: "POST", headers: { Authorization: `Bearer ${SECRET}` },
      }), env())
      expect(rebuild?.status, await rebuild?.clone().text()).toBe(200)
      expect((await t.pg.query("SELECT * FROM cell_audio ORDER BY audio_id")).rows).toEqual(after)
      // A later removal must still replay as a tombstone, not cause the earlier
      // historical attach to disappear by reading a future event out of order.
      const remove = { ...ordinary, id: `later-remove-${state}`, kind: "cell.audio.remove", payload: { audioId: "old.wav" } }
      expect((await handleMigrateIngestRequest(ingestRequest([remove]), env()))?.status).toBe(200)
      const deleted = (await t.pg.query("SELECT * FROM cell_audio ORDER BY audio_id")).rows
      await t.pg.query("DELETE FROM cell_audio")
      const replayDeleted = await handleRebuildProjectionRequest(new Request(`https://sync.test/admin/projects/${PROJECT}/rebuild-projection?fullReplay=1`, {
        method: "POST", headers: { Authorization: `Bearer ${SECRET}` },
      }), env())
      expect(replayDeleted?.status).toBe(200)
      expect((await t.pg.query("SELECT * FROM cell_audio ORDER BY audio_id")).rows).toEqual(deleted)
      // Even if a tombstone row was purged, its logged removal prevents a later
      // recovery from bringing the recording back.
      await t.pg.query("DELETE FROM cell_audio WHERE audio_id='old.wav'")
      expect((await handleMigrateIngestRequest(ingestRequest([{ ...recovery[0], id: `new-recovery-${state}` }]), env()))?.status).toBe(200)
      expect((await t.pg.query("SELECT * FROM cell_audio WHERE audio_id='old.wav'")).rows).toHaveLength(0)
    }
  }, 120_000)

  it("assigns unique ascending seqs from one allocated block (eventsOnly firehose)", async () => {
    const events = ["e1", "e2", "e3", "e4", "e5"].map((id, i) => cellCreate(id, `c${i}`, `v${i}`))
    const res = await handleMigrateIngestRequest(ingestRequest(events, { eventsOnly: true }), env())
    expect(res?.status).toBe(200)
    expect(await res!.json()).toEqual({ accepted: 5, replayed: 0 })

    const rows = await eventSeqs()
    expect(rows.map((r) => r.id)).toEqual(["e1", "e2", "e3", "e4", "e5"])
    const seqs = rows.map((r) => Number(r.server_seq))
    expect(new Set(seqs).size).toBe(5)
    // Contiguous block in request order — the allocator hands out base..base+4.
    expect(seqs).toEqual([seqs[0], seqs[0] + 1, seqs[0] + 2, seqs[0] + 3, seqs[0] + 4])
  })

  it("replaying a batch drops duplicate ids without disturbing existing rows", async () => {
    const events = ["r1", "r2", "r3"].map((id, i) => cellCreate(id, `c${i}`, `v${i}`))
    await handleMigrateIngestRequest(ingestRequest(events, { eventsOnly: true }), env())
    const before = await eventSeqs()

    const replay = await handleMigrateIngestRequest(ingestRequest(events, { eventsOnly: true }), env())
    expect(replay?.status).toBe(200)

    const after = await eventSeqs()
    // Same 3 rows, same seqs — the replay consumed a fresh block (harmless
    // gap; seq is an ordering key, not a count) and inserted nothing.
    expect(after).toEqual(before)
  })

  it("allocates strictly above pre-existing events when the counter is unseeded", async () => {
    // Simulate rows written before the counter existed (e.g. a pre-allocator
    // deploy): event at seq 100 with NO project_seq_counters row.
    await t.pg.query(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind,
                           author, payload, client_ts, server_ts, server_seq)
       VALUES ('old-1', 1, $1, $2, 'c-old', NULL, 'source.cell.create',
               'legacy-user', '{}', 1, 1, 100)`,
      [PROJECT, FILE],
    )

    await handleMigrateIngestRequest(
      ingestRequest([cellCreate("n1", "c-new", "new")], { eventsOnly: true }),
      env(),
    )
    const rows = await eventSeqs()
    const n1 = rows.find((r) => r.id === "n1")!
    expect(Number(n1.server_seq)).toBeGreaterThan(100)
  })

  it("replayed ids skip projection statements (idempotent retry)", async () => {
    await handleMigrateIngestRequest(ingestRequest([cellCreate("e1", "c1", "first")]), env())
    // Simulate a retry that carries a *different* value for the same id.
    const r = await handleMigrateIngestRequest(ingestRequest([cellCreate("e1", "c1", "changed")]), env())
    expect(((await r!.json()) as { accepted: number }).accepted).toBe(0)
    const rows = await t.pg.query<{ value: string }>("SELECT value FROM cells WHERE project_id=$1 AND cell_id=$2", [PROJECT, "c1"])
    expect(rows.rows[0].value).toBe("first")
    expect((await eventSeqs()).length).toBe(1)
  })

  it("non-eventsOnly still projects cells alongside the event rows", async () => {
    const events: IngestEventIn[] = [
      {
        id: "f1",
        kind: "file.create",
        fileId: FILE,
        cellId: null,
        parentId: null,
        author: "legacy-user",
        clientTs: 1600000000000,
        payload: { name: "GEN", fileType: "codex" },
      },
      cellCreate("s1", "cell-1", "In the beginning"),
    ]
    const res = await handleMigrateIngestRequest(ingestRequest(events), env())
    expect(res?.status).toBe(200)

    const cell = await t.pg.query(
      "SELECT value FROM cells WHERE project_id=$1 AND file_id=$2 AND cell_id='cell-1' AND side='source'",
      [PROJECT, FILE],
    )
    expect(cell.rows).toHaveLength(1)
    expect((cell.rows[0] as { value: string }).value).toBe("In the beginning")
    expect((await eventSeqs()).map((r) => r.id)).toEqual(["f1", "s1"])
  })

  // AQU-1005 audit M2: a rejected body must not leave a pending allocation
  // behind. A live seq_allocations row clamps the project's advertised reader
  // cursor (fetchPendingFloor) for the whole PENDING_ALLOC_TTL_MS, so letting a
  // malformed request take one would stall every reader on this project for
  // five minutes for a request that wrote nothing. Hence: validate first,
  // allocate second.
  async function liveAllocations(): Promise<number> {
    const r = await t.pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM seq_allocations WHERE project_id=$1",
      [PROJECT],
    )
    return Number(r.rows[0].n)
  }

  it("a malformed event body is rejected without pinning a seq allocation", async () => {
    const events = [
      cellCreate("ok1", "c1", "v1"),
      { ...cellCreate("bad1", "c2", "v2"), author: 42 as unknown as string },
    ]
    const res = await handleMigrateIngestRequest(ingestRequest(events), env())
    expect(res?.status).toBe(400)

    expect(await liveAllocations()).toBe(0)
    expect(await eventSeqs()).toEqual([])
  })

  it("an unprojectable event is rejected without pinning a seq allocation", async () => {
    const events = [
      cellCreate("ok2", "c1", "v1"),
      { ...cellCreate("bad2", "c2", "v2"), kind: "totally.unknown.kind" },
    ]
    const res = await handleMigrateIngestRequest(ingestRequest(events), env())
    expect(res?.status).toBe(400)

    expect(await liveAllocations()).toBe(0)
    expect(await eventSeqs()).toEqual([])
  })

  it("a rejected batch leaves the next good batch's seqs unfenced", async () => {
    const bad = [{ ...cellCreate("bad3", "c1", "v1"), schemaVersion: 99 }]
    expect(
      (await handleMigrateIngestRequest(ingestRequest(bad as IngestEventIn[]), env()))?.status,
    ).toBe(400)

    const good = ["g1", "g2"].map((id, i) => cellCreate(id, `c${i}`, `v${i}`))
    const res = await handleMigrateIngestRequest(ingestRequest(good, { eventsOnly: true }), env())
    expect(res?.status).toBe(200)
    expect((await eventSeqs()).map((r) => r.id)).toEqual(["g1", "g2"])
    // settled by the batch's settle statement
    expect(await liveAllocations()).toBe(0)
  })

  it("AQU-1240: ingest creates lanes and projects lane_id onto source and target cells", async () => {
    const events: IngestEventIn[] = [
      {
        id: "f1",
        kind: "file.create",
        fileId: FILE,
        cellId: null,
        parentId: null,
        author: "legacy-import",
        clientTs: 1600000000000,
        payload: { name: "GEN", fileType: "codex" },
      },
      cellCreate("s1", "cell-1", "Hello"),
      {
        id: "t-default",
        kind: "target.cell.commit",
        fileId: FILE,
        cellId: "cell-1",
        parentId: "s1",
        author: "legacy-import",
        clientTs: 1600000000001,
        payload: { value: "Bonjour" },
      },
      {
        id: "t-es",
        kind: "target.cell.commit",
        fileId: FILE,
        cellId: "cell-1",
        parentId: "s1",
        author: "legacy-import",
        clientTs: 1600000000002,
        payload: { value: "Hola", targetLang: "es" },
      },
    ]
    const res = await handleMigrateIngestRequest(ingestRequest(events), env())
    expect(res?.status).toBe(200)

    const laneRows = await t.pg.query<{ role: string; legacy_tag: string | null }>(
      `SELECT role, legacy_tag FROM lanes WHERE project_id=$1 ORDER BY role, legacy_tag NULLS FIRST`,
      [PROJECT],
    )
    expect(laneRows.rows).toEqual([
      { role: "source", legacy_tag: null },
      { role: "target", legacy_tag: "" },
      { role: "target", legacy_tag: "es" },
    ])

    const cells = await t.pg.query<{ side: string; target_lang: string; lane_id: string | null }>(
      `SELECT c.side, COALESCE(l.legacy_tag, '') AS target_lang, c.lane_id
         FROM cells c
         LEFT JOIN lanes l ON l.project_id = c.project_id AND l.id = c.lane_id
        WHERE c.project_id=$1
        ORDER BY c.side, target_lang`,
      [PROJECT],
    )
    expect(cells.rows).toHaveLength(3)
    expect(cells.rows.every((r) => typeof r.lane_id === "string" && r.lane_id.length > 0)).toBe(true)
    const sourceId = cells.rows.find((r) => r.side === "source")?.lane_id
    const defaultId = cells.rows.find((r) => r.side === "target" && r.target_lang === "")?.lane_id
    const esId = cells.rows.find((r) => r.side === "target" && r.target_lang === "es")?.lane_id
    expect(new Set([sourceId, defaultId, esId]).size).toBe(3)
  })
})
