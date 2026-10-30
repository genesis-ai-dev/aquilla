// AQU-2227 — migration 0194 clears a stored Follows recordings choice on files
// with a film linked.
//
// WHY: before this release a file timed to a film (footage linked, or an audio
// cue file paired with it) was LOCKED to Follows source, so a stored
// 'audioFirst' on such a file was never shown. AQU-2227 lets the file's own
// choice win, so without this fix those files would switch to Follows
// recordings at deploy. Clearing too much would wipe a choice that users do
// see today: a file with no film and no cue file that follows its recordings.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../db/postgres/migrations/0194_film_files_clear_follows_recordings.sql",
  ),
  "utf8",
)

const PROJECT = "proj-0194"
const FILM = "https://cdn.example.test/videos/ep1/master.m3u8"

let t: TestDb | undefined
afterEach(async () => {
  await t?.close()
  t = undefined
})

// id → [kind, role, meta text, anchor_file_id, deleted_at]
const FILES: Record<string, [string, string, string, string | null, number | null]> = {
  "sub-film-free": ["vtt", "source", JSON.stringify({ coreMediaUrl: FILM, timingMode: "audioFirst", orderedBy: "time" }), null, null],
  "book-film-free": ["helloao", "source", JSON.stringify({ timingMode: "audioFirst", coreMediaUrl: "https://youtu.be/abc" }), null, null],
  "deleted-film-free": ["vtt", "source", JSON.stringify({ coreMediaUrl: FILM, timingMode: "audioFirst" }), null, 1_700_000_000_000],
  "film-source": ["vtt", "source", JSON.stringify({ coreMediaUrl: FILM, timingMode: "dubbing" }), null, null],
  "film-no-choice": ["vtt", "source", JSON.stringify({ coreMediaUrl: FILM }), null, null],
  "no-film-free": ["helloao", "source", JSON.stringify({ timingMode: "audioFirst" }), null, null],
  "empty-film-free": ["vtt", "source", JSON.stringify({ coreMediaUrl: "", timingMode: "audioFirst" }), null, null],
  "null-film-free": ["vtt", "source", JSON.stringify({ coreMediaUrl: null, timingMode: "audioFirst" }), null, null],
  "blank-film-free": ["vtt", "source", JSON.stringify({ coreMediaUrl: "   ", timingMode: "audioFirst" }), null, null],
  "cues-free": ["vtt", "source", JSON.stringify({ timingMode: "audioFirst" }), null, null],
  "cues-free-cues": ["vtt", "audio-cues", "{}", "cues-free", null],
  // A deleted cue file no longer reaches the app, so it times nothing.
  "dead-cues-free": ["vtt", "source", JSON.stringify({ timingMode: "audioFirst" }), null, null],
  "dead-cues-free-cues": ["vtt", "audio-cues", "{}", "dead-cues-free", 1_700_000_000_000],
  "blank-meta": ["vtt", "source", "", null, null],
}

const CLEARED = ["sub-film-free", "book-film-free", "deleted-film-free", "cues-free"]

async function seed(td: TestDb): Promise<void> {
  for (const [id, [kind, role, meta, anchor, deletedAt]] of Object.entries(FILES)) {
    await td.pg.query(
      `INSERT INTO files (id, project_id, name, kind, role, meta, anchor_file_id, deleted_at, event_id, updated_at)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, 'ev-' || $1, 1000)`,
      [id, PROJECT, kind, role, meta, anchor, deletedAt],
    )
  }
}

async function snapshot(td: TestDb): Promise<Record<string, { meta: string; event_id: string; updated_at: string }>> {
  const { rows } = await td.pg.query<{ id: string; meta: string; event_id: string; updated_at: string }>(
    `SELECT id, meta, event_id, updated_at::text AS updated_at FROM files WHERE project_id = $1 ORDER BY id`,
    [PROJECT],
  )
  return Object.fromEntries(rows.map(({ id, ...rest }) => [id, rest]))
}

describe("migration 0194", () => {
  it("clears Follows recordings only on files with a film or a live audio cue file, keeps their other keys, and is safe to re-run", async () => {
    const td = (t = await makeTestDb())
    await seed(td)
    const before = await snapshot(td)

    await td.pg.exec(MIGRATION)
    const after = await snapshot(td)

    for (const [id, [, , meta]] of Object.entries(FILES)) {
      if (CLEARED.includes(id)) {
        const expected = JSON.parse(meta) as Record<string, unknown>
        delete expected.timingMode
        expect(JSON.parse(after[id].meta), id).toEqual(expected)
      } else {
        // Not rewritten at all, byte for byte.
        expect(after[id].meta, id).toBe(before[id].meta)
      }
      // A correction, not an edit: the file's event and timestamp stay.
      expect(after[id].event_id, id).toBe(before[id].event_id)
      expect(after[id].updated_at, id).toBe(before[id].updated_at)
    }

    await td.pg.exec(MIGRATION)
    expect(await snapshot(td)).toEqual(after)
  })
})
