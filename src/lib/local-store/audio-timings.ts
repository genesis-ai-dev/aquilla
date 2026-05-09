/**
 * Typed access to the edit-keyed `audio_timings` projection.
 *
 * One row per attachment, carrying the full WordTiming[] as a JSON blob
 * (see migration 003 for rationale). The (cell_id, cell_version_at,
 * text_snapshot) trio makes timings naturally interpretable when the
 * cell text moves: char offsets refer to text_snapshot, not the live
 * translation, so the karaoke renderer can detect drift and gray out
 * stale entries instead of underlining nonsense.
 *
 * See DATA_PERSISTENCE_PLAN.md §4.11.
 */

import type { LocalStore } from "./db"

export interface WordTiming {
  word: string
  /** seconds from the start of the audio clip */
  t0: number
  t1: number
  /** char offsets into text_snapshot */
  start: number
  end: number
}

export interface AudioTimingsRow {
  attachment_id: string
  cell_id: string
  cell_version_at: number
  text_snapshot: string
  timings: WordTiming[]
  generated_by: string
  generated_at: number
  seq: number
}

const UPSERT_SQL = `INSERT OR REPLACE INTO audio_timings (
  attachment_id, cell_id, cell_version_at, text_snapshot,
  timings_json, generated_by, generated_at, seq
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

export async function upsertAudioTimings(
  store: LocalStore,
  row: AudioTimingsRow,
): Promise<void> {
  await store.run(UPSERT_SQL, [
    row.attachment_id,
    row.cell_id,
    row.cell_version_at,
    row.text_snapshot,
    JSON.stringify(row.timings),
    row.generated_by,
    row.generated_at,
    row.seq,
  ])
}

interface AudioTimingsRawRow {
  attachment_id: string
  cell_id: string
  cell_version_at: number
  text_snapshot: string
  timings_json: string
  generated_by: string
  generated_at: number
  seq: number
}

function hydrate(raw: AudioTimingsRawRow): AudioTimingsRow {
  let timings: WordTiming[] = []
  try {
    const parsed = JSON.parse(raw.timings_json) as unknown
    if (Array.isArray(parsed)) timings = parsed as WordTiming[]
  } catch {
    /* malformed JSON → empty timings; the row stays interpretable */
  }
  return {
    attachment_id: raw.attachment_id,
    cell_id: raw.cell_id,
    cell_version_at: raw.cell_version_at,
    text_snapshot: raw.text_snapshot,
    timings,
    generated_by: raw.generated_by,
    generated_at: raw.generated_at,
    seq: raw.seq,
  }
}

export async function getAudioTimingsByAttachment(
  store: LocalStore,
  attachmentId: string,
): Promise<AudioTimingsRow | null> {
  const rows = await store.query<AudioTimingsRawRow>(
    "SELECT * FROM audio_timings WHERE attachment_id = ?",
    [attachmentId],
  )
  return rows[0] ? hydrate(rows[0]) : null
}

export async function getAudioTimingsForCell(
  store: LocalStore,
  cellId: string,
): Promise<AudioTimingsRow[]> {
  const rows = await store.query<AudioTimingsRawRow>(
    `SELECT * FROM audio_timings
     WHERE cell_id = ?
     ORDER BY cell_version_at DESC, generated_at DESC`,
    [cellId],
  )
  return rows.map(hydrate)
}
