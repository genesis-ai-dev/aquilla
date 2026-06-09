// Tests for the cell-audio event grammar: projection SQL/bindings for
// cell.audio.attach / .select / .remove, and the per-file read route's
// grouping + selection logic.

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { handleCellAudioReadRequest } from "../events/cell-audio-read-route"
import type { EventKind } from "../events/types"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cell-audio-secret"

// ── Projection: a recording DB stub that captures (sql, args) ─────────────
interface RecordedStmt {
  sql: string
  args: unknown[]
}
function makeRecordingDb() {
  const recorded: RecordedStmt[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          recorded.push({ sql: sql.replace(/\s+/g, " ").trim(), args })
          return this
        },
      } as unknown as AquillaStatement
    },
  } as unknown as AquillaDb
  return { db, recorded }
}

function makeEvent<K extends EventKind>(kind: K, payload: unknown): PersistedEvent {
  return {
    id: "evt-audio-1",
    schemaVersion: 1,
    projectId: "p1",
    fileId: "f1",
    cellId: "c1",
    parentId: null,
    kind,
    author: "alice",
    payload,
    clientTs: 10,
    serverTs: 100,
    serverSeq: 5,
  }
}

describe("cell-audio projection", () => {
  it("attach: deselects siblings in the slot, then upserts selected+live", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.attach", {
        audioId: "audio-x.wav",
        url: "frontier-audio://audio-x.wav",
        slot: "generatedVoice",
        mimeType: "audio/wav",
        voiceId: "voice-clone-1",
        referenceAudioId: "ref-1.webm",
        durationMs: 5108,
        timings: [{ word: "hi", t0: 0, t1: 0.5, start: 0, end: 2 }],
      }),
      stmts,
    )
    expect(touches).toEqual(["cell_audio"])
    expect(stmts).toHaveLength(2)

    // First: deselect other clips in the same slot (never this audio_id).
    expect(recorded[0].sql).toContain("UPDATE cell_audio SET selected = 0")
    expect(recorded[0].sql).toContain("slot = ? AND audio_id != ?")
    expect(recorded[0].args).toEqual(["p1", "f1", "c1", "generatedVoice", "audio-x.wav"])

    // Second: upsert this clip as selected + live, timings serialized.
    expect(recorded[1].sql).toContain("INSERT INTO cell_audio")
    expect(recorded[1].sql).toContain("ON CONFLICT(project_id, file_id, cell_id, audio_id)")
    const a = recorded[1].args
    expect(a[0]).toBe("p1")
    expect(a[3]).toBe("audio-x.wav")
    expect(a[4]).toBe("generatedVoice")
    expect(a[5]).toBe("frontier-audio://audio-x.wav")
    expect(a[6]).toBe("audio/wav")
    expect(a[7]).toBe("voice-clone-1")
    expect(a[8]).toBe("ref-1.webm")
    expect(a[9]).toBe(5108)
    expect(a[10]).toBeNull() // trim_start_ms (unset)
    expect(a[11]).toBeNull() // trim_end_ms (unset)
    expect(a[12]).toBe(JSON.stringify([{ word: "hi", t0: 0, t1: 0.5, start: 0, end: 2 }]))
    expect(a[13]).toBe("evt-audio-1") // event_id
    expect(a[14]).toBe(100) // created_ts = serverTs
  })

  it("attach: nulls optional fields when omitted", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.attach", {
        audioId: "rec.webm",
        url: "frontier-audio://rec.webm",
        slot: "recording",
      }),
      stmts,
    )
    const a = recorded[1].args
    expect(a[6]).toBeNull() // mime_type
    expect(a[7]).toBeNull() // voice_id
    expect(a[8]).toBeNull() // reference_audio_id
    expect(a[9]).toBeNull() // duration_ms
    expect(a[10]).toBeNull() // timings_json
  })

  it("select: deselects siblings then selects the target", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.select", { audioId: "audio-y.wav", slot: "recording" }),
      stmts,
    )
    expect(touches).toEqual(["cell_audio"])
    expect(stmts).toHaveLength(2)
    expect(recorded[0].sql).toContain("SET selected = 0")
    expect(recorded[0].args).toEqual(["p1", "f1", "c1", "recording", "audio-y.wav"])
    expect(recorded[1].sql).toContain("SET selected = 1, deleted = 0")
    expect(recorded[1].args).toEqual(["p1", "f1", "c1", "audio-y.wav"])
  })

  it("remove: soft-deletes and deselects", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.remove", { audioId: "audio-z.wav" }),
      stmts,
    )
    expect(touches).toEqual(["cell_audio"])
    expect(stmts).toHaveLength(1)
    expect(recorded[0].sql).toContain("SET deleted = 1, selected = 0")
    expect(recorded[0].args).toEqual(["p1", "f1", "c1", "audio-z.wav"])
  })
})

// ── Read route: canned-rows DB stub ───────────────────────────────────────
interface AudioRow {
  cell_id: string
  audio_id: string
  slot: string
  url: string
  mime_type: string | null
  voice_id: string | null
  reference_audio_id: string | null
  duration_ms: number | null
  timings_json: string | null
  selected: number
  created_ts: number
}
function makeReadDb(rows: AudioRow[]) {
  return {
    prepare() {
      return {
        bind() {
          return {
            all: async <T>() => ({ results: rows as unknown as T[] }),
          }
        },
      }
    },
  } as unknown as AquillaDb
}

async function readReq(env: { AQUILLA_PG?: AquillaDb; SYNC_SECRET_KEY?: string }, token?: string) {
  return handleCellAudioReadRequest(
    new Request("https://w/api/v1/projects/p1/files/f1/audio-attachments", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
  )
}

describe("GET /api/v1/projects/:p/files/:f/audio-attachments", () => {
  it("returns null for unrelated paths", async () => {
    const res = await handleCellAudioReadRequest(
      new Request("https://w/audio/p1/f1/x.wav"),
      { AQUILLA_PG: makeReadDb([]), SYNC_SECRET_KEY: SECRET },
    )
    expect(res).toBeNull()
  })

  it("401 without a token", async () => {
    const res = (await readReq({ AQUILLA_PG: makeReadDb([]), SYNC_SECRET_KEY: SECRET }))!
    expect(res.status).toBe(401)
  })

  it("groups attachments per cell and maps selected per slot", async () => {
    const rows: AudioRow[] = [
      {
        cell_id: "c1", audio_id: "rec1.webm", slot: "recording", url: "frontier-audio://rec1.webm",
        mime_type: "audio/webm", voice_id: null, reference_audio_id: null, duration_ms: 1000,
        timings_json: null, selected: 1, created_ts: 1,
      },
      {
        cell_id: "c1", audio_id: "gen1.wav", slot: "generatedVoice", url: "frontier-audio://gen1.wav",
        mime_type: "audio/wav", voice_id: "v1", reference_audio_id: "ref1.webm", duration_ms: 2000,
        timings_json: JSON.stringify([{ word: "x", t0: 0, t1: 1, start: 0, end: 1 }]), selected: 1, created_ts: 2,
      },
      {
        cell_id: "c2", audio_id: "rec2.webm", slot: "recording", url: "frontier-audio://rec2.webm",
        mime_type: "audio/webm", voice_id: null, reference_audio_id: null, duration_ms: 500,
        timings_json: null, selected: 0, created_ts: 3,
      },
    ]
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1" })
    const res = (await readReq({ AQUILLA_PG: makeReadDb(rows), SYNC_SECRET_KEY: SECRET }, token))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cells: Record<string, {
        attachments: Record<string, unknown>
        selectedAudioId: string | null
        selectedGeneratedVoiceAudioId: string | null
        audioTimings: Record<string, unknown>
      }>
    }
    expect(Object.keys(body.cells).sort()).toEqual(["c1", "c2"])
    expect(Object.keys(body.cells.c1.attachments).sort()).toEqual(["gen1.wav", "rec1.webm"])
    expect(body.cells.c1.selectedAudioId).toBe("rec1.webm")
    expect(body.cells.c1.selectedGeneratedVoiceAudioId).toBe("gen1.wav")
    expect(body.cells.c1.audioTimings["gen1.wav"]).toEqual([{ word: "x", t0: 0, t1: 1, start: 0, end: 1 }])
    // c2's only clip is unselected → both selections null.
    expect(body.cells.c2.selectedAudioId).toBeNull()
    expect(body.cells.c2.selectedGeneratedVoiceAudioId).toBeNull()
  })
})
