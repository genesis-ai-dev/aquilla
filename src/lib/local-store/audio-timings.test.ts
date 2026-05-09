/**
 * Repository tests for the edit-keyed `audio_timings` table.
 * See DATA_PERSISTENCE_PLAN.md §4.10–§4.12 and migration 003.
 */

import { beforeEach, describe, expect, test } from "vitest"
import { LocalStore } from "./db"
import { MIGRATIONS } from "./migrations"
import {
  getAudioTimingsByAttachment,
  getAudioTimingsForCell,
  upsertAudioTimings,
  type AudioTimingsRow,
  type WordTiming,
} from "./audio-timings"

const NOW = 1_700_000_000_000

const TIMINGS: WordTiming[] = [
  { word: "In", t0: 0.0, t1: 0.18, start: 0, end: 2 },
  { word: "the", t0: 0.18, t1: 0.32, start: 3, end: 6 },
  { word: "beginning", t0: 0.32, t1: 0.92, start: 7, end: 16 },
]

function makeRow(overrides: Partial<AudioTimingsRow> = {}): AudioTimingsRow {
  return {
    attachment_id: "p1:c1::att-audio-1",
    cell_id: "p1:c1",
    cell_version_at: 3,
    text_snapshot: "In the beginning",
    timings: TIMINGS,
    generated_by: "ai:whisper",
    generated_at: NOW,
    seq: 1,
    ...overrides,
  }
}

describe("audio_timings repository", () => {
  let store: LocalStore

  beforeEach(async () => {
    store = await LocalStore.open({ name: ":memory:" })
    await store.migrate(MIGRATIONS)
  })

  test("upsertAudioTimings + getAudioTimingsByAttachment round-trip", async () => {
    const row = makeRow()
    await upsertAudioTimings(store, row)
    const got = await getAudioTimingsByAttachment(
      store,
      row.attachment_id,
    )
    expect(got).toEqual(row)
  })

  test("upsertAudioTimings replaces an existing row in-place", async () => {
    await upsertAudioTimings(store, makeRow({ generated_at: NOW }))
    await upsertAudioTimings(
      store,
      makeRow({
        generated_at: NOW + 1000,
        timings: [{ word: "rewritten", t0: 0, t1: 1, start: 0, end: 9 }],
      }),
    )
    const got = await getAudioTimingsByAttachment(
      store,
      "p1:c1::att-audio-1",
    )
    expect(got?.timings[0].word).toBe("rewritten")
    expect(got?.generated_at).toBe(NOW + 1000)
  })

  test("getAudioTimingsByAttachment returns null when missing", async () => {
    expect(
      await getAudioTimingsByAttachment(store, "missing"),
    ).toBeNull()
  })

  test("getAudioTimingsForCell returns all rows for a cell, ordered newest-first", async () => {
    await upsertAudioTimings(
      store,
      makeRow({
        attachment_id: "p1:c1::att-1",
        cell_version_at: 3,
        generated_at: NOW,
      }),
    )
    await upsertAudioTimings(
      store,
      makeRow({
        attachment_id: "p1:c1::att-2",
        cell_version_at: 5,
        generated_at: NOW + 100,
      }),
    )
    const rows = await getAudioTimingsForCell(store, "p1:c1")
    expect(rows.map((r) => r.attachment_id)).toEqual([
      "p1:c1::att-2",
      "p1:c1::att-1",
    ])
  })

  test("WordTiming[] serializes + deserializes through SQLite intact", async () => {
    const t: WordTiming[] = [
      { word: "a", t0: 0, t1: 0.5, start: 0, end: 1 },
      { word: "b", t0: 0.5, t1: 1, start: 2, end: 3 },
    ]
    await upsertAudioTimings(store, makeRow({ timings: t }))
    const got = await getAudioTimingsByAttachment(
      store,
      "p1:c1::att-audio-1",
    )
    expect(got?.timings).toEqual(t)
  })
})
