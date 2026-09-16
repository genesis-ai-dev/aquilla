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
    expect(a[10]).toBeNull() // label (unset — COALESCE keeps any existing name)
    expect(a[11]).toBeNull() // trim_start_ms (unset)
    expect(a[12]).toBeNull() // trim_end_ms (unset)
    expect(a[13]).toBe(JSON.stringify([{ word: "hi", t0: 0, t1: 0.5, start: 0, end: 2 }]))
    expect(a[14]).toBe("evt-audio-1") // event_id
    expect(a[15]).toBe(100) // created_ts = serverTs
  })

  it("attach: binds NULL for optional fields the payload omits", () => {
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
    expect(a[11]).toBeNull() // timings_json (label took index 10 in round 8)
  })

  // SUB-49 — a re-attach may only ADD to what we know about a clip.
  //
  // Transcription re-attaches carrying ONLY its timings, and a trim carrying
  // only trims. While these columns were plain `excluded.x` assignments, a
  // NULL bind meant "erase", so finishing a transcription silently wiped a
  // recording's duration (its chip lost its length and fell back to the
  // section's width), its mime type and its voice — and the later re-attach
  // that restored the duration wiped the transcription's timings straight
  // back. Verified in the event log on a real take before this fix.
  it("attach: a partial re-attach PRESERVES the clip's descriptive fields", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.attach", {
        audioId: "rec.webm",
        url: "frontier-audio://rec.webm",
        slot: "recording",
        timings: [{ word: "hi", t0: 0, t1: 0.5, start: 0, end: 2 }],
      }),
      [],
    )
    const sql = recorded.find((s) => s.sql.includes("INSERT INTO cell_audio"))!.sql
    for (const col of ["duration_ms", "mime_type", "voice_id", "reference_audio_id", "timings_json", "label"]) {
      expect(sql).toContain(`${col} = COALESCE(excluded.${col}, cell_audio.${col})`)
    }
  })

  // 2026-08-14: this test used to assert the OPPOSITE — that trims stayed a
  // plain overwrite "so dragging to the clip edge still CLEARS them". That
  // exemption was the last instance of the very bug the test above describes,
  // and it cost three takes in a row: an attach carrying only word timings
  // (the transcription's, ~800ms after a take is saved) nulled the trim window
  // the save had just written, and the take was left anchored a few hundred ms
  // early with nothing to undo the shift. Clearing now belongs to
  // cell.audio.trim, which states both ends and can therefore mean NULL out
  // loud — see audio-trim-projection.test.ts.
  it("attach: trims are COALESCEd too — an attach may SET a window, never wipe one", () => {
    const { db, recorded } = makeRecordingDb()
    buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.attach", {
        audioId: "rec.webm",
        url: "frontier-audio://rec.webm",
        slot: "recording",
      }),
      [],
    )
    const sql = recorded.find((s) => s.sql.includes("INSERT INTO cell_audio"))!.sql
    expect(sql).toContain("trim_start_ms = COALESCE(excluded.trim_start_ms, cell_audio.trim_start_ms)")
    expect(sql).toContain("trim_end_ms = COALESCE(excluded.trim_end_ms, cell_audio.trim_end_ms)")
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

  // ── AQU-646 stage 3: cell.audio.place ────────────────────────────────────
  //
  // Where ONE take sits against the line it performs. Its own kind rather than
  // a field on attach, because absence has to keep meaning exactly one thing.

  it("place: writes the offset onto that take and nothing else", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.place", { audioId: "audio-z.wav", targetOffsetMs: -250 }),
      stmts,
    )
    expect(touches).toEqual(["cell_audio"])
    expect(stmts).toHaveLength(1)
    expect(recorded[0].sql).toContain("SET target_offset_ms = ?")
    // Addressed by audio_id alone — it is part of the primary key, so naming
    // the take names the row and a slot term could only disagree with itself.
    expect(recorded[0].args).toEqual([-250, "p1", "f1", "c1", "audio-z.wav"])
    // It touches nothing else: not selection, not trims, not the cell.
    expect(recorded[0].sql).not.toContain("selected")
    expect(recorded[0].sql).not.toContain("trim_")
    expect(recorded[0].sql).not.toContain("UPDATE cells")
  })

  // `?? null`, never `|| null`. Zero is a take placed exactly on its line's
  // start — the commonest placement there is — and `||` would store it as
  // "never placed by hand".
  it("place: an offset of exactly 0 is stored as 0, not as NULL", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.place", { audioId: "audio-z.wav", targetOffsetMs: 0 }),
      stmts,
    )
    expect(recorded[0].args[0]).toBe(0)
  })

  it("place: null CLEARS the placement back to the line's start", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.place", { audioId: "audio-z.wav", targetOffsetMs: null }),
      stmts,
    )
    expect(recorded[0].args[0]).toBeNull()
  })

  // AQU-646: transcription rides cell.audio.attach (contributor floor) instead
  // of source.cell.create (lead floor + full-overwrite UPSERT would clobber
  // segment fields). The write is CONDITIONAL — attaches without the field
  // must not touch `cells` at all, so re-attaching a recorded take can never
  // blank out an existing transcript.
  it("attach with transcription: additionally updates the SOURCE cell's transcription", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.attach", {
        audioId: "clip.mp3",
        url: "frontier-audio://clip.mp3",
        slot: "recording",
        trimStartMs: 1000,
        trimEndMs: 4000,
        transcription: "hello imported world",
      }),
      stmts,
    )
    expect(touches).toEqual(["cell_audio", "cells"])
    expect(stmts).toHaveLength(3)
    expect(recorded[2].sql).toContain("UPDATE cells SET transcription = ?")
    expect(recorded[2].sql).toContain("side = 'source'")
    expect(recorded[2].args).toEqual(["hello imported world", "p1", "f1", "c1"])
  })

  it("attach without transcription: cells table is untouched", () => {
    const { db, recorded } = makeRecordingDb()
    const stmts: AquillaStatement[] = []
    const touches = buildEventProjectionStmts(
      db,
      makeEvent("cell.audio.attach", {
        audioId: "take.webm",
        url: "frontier-audio://take.webm",
        slot: "recording",
        timings: [{ word: "hi", t0: 0, t1: 0.5, start: 0, end: 2 }],
      }),
      stmts,
    )
    expect(touches).toEqual(["cell_audio"])
    expect(stmts).toHaveLength(2)
    for (const r of recorded) expect(r.sql).not.toContain("UPDATE cells")
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

  // ── AQU-646 stage 3: a selection on an ADDED target track ────────────────
  //
  // THIS ROUTE IS THE ONLY PLACE SUCH A SELECTION COULD BE LOST, and before
  // `selectedBySlot` it was: the two named pointers are an if/else over two
  // literals with no fallthrough, so a row selected in a third slot arrived
  // inside `attachments` with its slot intact and was pointed at by nothing.
  it("reports the selection in EVERY slot, not only the two well-known ones", async () => {
    const TRK = "019fd21a-a5a4-75d1-b8c4-3b60072a4fc2"
    const rows: AudioRow[] = [
      {
        cell_id: "c1", audio_id: "rec1.webm", slot: "recording", url: "frontier-audio://rec1.webm",
        mime_type: "audio/webm", voice_id: null, reference_audio_id: null, duration_ms: 1000,
        timings_json: null, selected: 1, created_ts: 1,
      },
      {
        cell_id: "c1", audio_id: "trk1.webm", slot: TRK, url: "frontier-audio://trk1.webm",
        mime_type: "audio/webm", voice_id: null, reference_audio_id: null, duration_ms: 900,
        timings_json: null, selected: 1, created_ts: 2,
      },
      {
        cell_id: "c1", audio_id: "trk0.webm", slot: TRK, url: "frontier-audio://trk0.webm",
        mime_type: "audio/webm", voice_id: null, reference_audio_id: null, duration_ms: 800,
        timings_json: null, selected: 0, created_ts: 3,
      },
    ]
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1" })
    const res = (await readReq({ AQUILLA_PG: makeReadDb(rows), SYNC_SECRET_KEY: SECRET }, token))!
    const body = (await res.json()) as {
      cells: Record<string, {
        selectedBySlot: Record<string, string>
        selectedAudioId: string | null
        selectedGeneratedVoiceAudioId: string | null
      }>
    }
    expect(body.cells.c1.selectedBySlot).toEqual({ recording: "rec1.webm", [TRK]: "trk1.webm" })
    // …and the two named pointers stay EXACTLY what they were. They are pure
    // projections of the map now, which is what stops the two shapes drifting —
    // a third slot must never leak into either of them.
    expect(body.cells.c1.selectedAudioId).toBe("rec1.webm")
    expect(body.cells.c1.selectedGeneratedVoiceAudioId).toBeNull()
  })

  it("leaves selectedBySlot empty when nothing on the cell is selected", async () => {
    const rows: AudioRow[] = [
      {
        cell_id: "c9", audio_id: "a.webm", slot: "recording", url: "frontier-audio://a.webm",
        mime_type: null, voice_id: null, reference_audio_id: null, duration_ms: null,
        timings_json: null, selected: 0, created_ts: 1,
      },
    ]
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1" })
    const res = (await readReq({ AQUILLA_PG: makeReadDb(rows), SYNC_SECRET_KEY: SECRET }, token))!
    const body = (await res.json()) as { cells: Record<string, { selectedBySlot: Record<string, string> }> }
    expect(body.cells.c9.selectedBySlot).toEqual({})
  })
})
