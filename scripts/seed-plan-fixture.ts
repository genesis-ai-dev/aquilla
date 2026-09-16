#!/usr/bin/env tsx
/**
 * AQU-1278 plan-board fixture — writes the project described by
 * `src/lib/plan/plan-fixture.ts` into a database.
 *
 *   AQUILLA_DATABASE_URL=postgresql://aquilla@localhost/aquilla_dev \
 *     ./node_modules/.bin/tsx scripts/seed-plan-fixture.ts
 *
 * IDEMPOTENT. Every run deletes the fixture project's rows and rebuilds them,
 * so re-run it freely after clicking around; it touches nothing outside the one
 * project id. Target dates are computed from the RUN date, so a fixture seeded
 * three weeks ago is refreshed by re-running rather than re-editing.
 *
 * WHY A SEEDER AND NOT ONLY AN IMPORT PACK. Validation state, recordings,
 * assignments, target dates and Done marks cannot come from a file import —
 * importing USFM gives you cells and nothing else. `write-plan-fixture-usfm.ts`
 * covers the import path; this covers everything the plan board actually reads.
 *
 * The progress numbers are produced by `fullProgressRecomputeStmts`, the same
 * statements the sync worker runs, and then read back and checked against the
 * fixture's own arithmetic. This file computes no progress number by hand.
 *
 * It takes the fixture TABLE from `src/lib/plan/plan-fixture.ts` but nothing
 * else from `src/`: the client's plan library reaches `import.meta.env` through
 * the auth module, which is undefined outside Vite. `plan-fixture.test.ts` is
 * where the fixture meets that library and its claimed groups are checked.
 */
import { makePostgres, type AquillaDb } from "../db/shim/postgres"
import { fullProgressRecomputeStmts } from "../sync-worker/src/events/progress-projection"
import {
  ALL_BOOKS, ASSIGNMENTS, AUDIO_BOOKS, AUDIO_FILE, EMPTY_FILE, LANE2, MEDIA_FILE,
  PROJECT_ID, PROJECT_NAME, TEXT_BOOKS, TEXT_FILE, VALIDATION_COUNT,
  assignedCells, cellsFor, expectedCounts, fileOf, isStructural,
} from "../src/lib/plan/plan-fixture"

const ORG = 1
const OWNER = 1 // dev
const NOW = Date.now()
const DAY = 86_400_000

/** A calendar date N days from today, as the 'YYYY-MM-DD' the column demands. */
const dateIn = (days: number): string =>
  new Date(NOW + days * DAY).toISOString().slice(0, 10)

interface FileSpec { id: string; name: string; kind: string | null; seq: number }

const FILES: FileSpec[] = [
  { id: TEXT_FILE, name: "bible-text.usfm", kind: null, seq: 1 },
  { id: AUDIO_FILE, name: "bible-dubbed.usfm", kind: null, seq: 2 },
  { id: MEDIA_FILE, name: "episode-03.vtt", kind: "media", seq: 3 },
  { id: EMPTY_FILE, name: "production-notes.md", kind: null, seq: 4 },
]
const eventOf = (fileId: string): string =>
  `${PROJECT_ID}-ev-${FILES.find((f) => f.id === fileId)!.seq}`

/** Batch multi-row inserts, so ~9,000 rows are a handful of round trips. */
async function insertRows(
  db: AquillaDb, table: string, columns: string[], rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return
  const CHUNK = 400
  const placeholder = `(${columns.map(() => "?").join(", ")})`
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    await db.prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${slice.map(() => placeholder).join(", ")}`,
    ).bind(...slice.flat()).run()
  }
}

const CELL_COLUMNS = [
  "project_id", "file_id", "cell_id", "side", "target_lang", "value", "type",
  "canonical_ref", "anchor_cell_id", "event_id", "last_editor", "last_edit_at",
  "validated", "endorsement_count", "word_count",
]

async function seed(db: AquillaDb): Promise<void> {
  // Idempotent teardown. A re-run must give back exactly this fixture, not this
  // fixture plus whatever was done to it in the UI.
  await db.prepare(
    "DELETE FROM assignment_cells WHERE assignment_id IN " +
    "(SELECT assignment_id FROM assignments WHERE project_id = ?)",
  ).bind(PROJECT_ID).run()
  for (const table of [
    "cell_audio", "cells", "file_section_progress", "files", "plan_units",
    "assignments", "project_settings", "project_members", "events",
  ]) {
    await db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(PROJECT_ID).run()
  }
  await db.prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT_ID).run()

  await db.prepare(
    "INSERT INTO projects (id, name, org_id, created_by, pm_user_id) VALUES (?, ?, ?, ?, ?)",
  ).bind(PROJECT_ID, PROJECT_NAME, ORG, OWNER, OWNER).run()

  // NO countStructuralCells key: the project INHERITS the org's, and Dev Org
  // sets it to false. The board is therefore read with headings EXCLUDED, which
  // is the policy under which the null-safe structural predicate matters. Turn
  // "count structural cells" on in project settings and every book's total
  // should rise by its chapter count while nothing disappears.
  await db.prepare(
    // VERSION 1, NOT THE COLUMN DEFAULT OF 0. `useProjectSettings` treats a
    // server row at version 0 as "never written" and keeps the client's local
    // settings instead, so a fixture seeded at 0 reaches the UI with no target
    // language at all: the inspector's meta line loses "German", the lane
    // table says "Default", and the multi-lane audio note never fires. Real
    // projects are never at 0 — the settings route stamps a version on every
    // write — so this is the fixture matching production, not a workaround.
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, ?)",
  ).bind(PROJECT_ID, JSON.stringify({
    sourceLanguage: "English",
    targetLanguage: "German",
    targetLanes: [LANE2],
    validationCount: VALIDATION_COUNT,
  }), OWNER).run()

  await insertRows(db, "project_members",
    ["project_id", "user_id", "role_level", "granted_by"],
    ([[OWNER, 700], [2, 600], [3, 400], [50, 400], [37, 400], [175, 400]] as const)
      .map(([user, level]) => [PROJECT_ID, user, level, OWNER]))

  await insertRows(db, "events",
    ["id", "schema_version", "project_id", "file_id", "kind", "author",
     "payload", "client_ts", "server_ts", "server_seq"],
    FILES.map((f) => [eventOf(f.id), 1, PROJECT_ID, f.id, "file.create", "dev", "{}", NOW, NOW, f.seq]))
  await insertRows(db, "files",
    ["id", "project_id", "name", "kind", "event_id", "created_by",
     "created_at", "updated_at", "last_edit_at"],
    FILES.map((f) => [f.id, PROJECT_ID, f.name, f.kind, eventOf(f.id), "dev", NOW, NOW, NOW - DAY]))

  const sourceRows: unknown[][] = []
  const targetRows: unknown[][] = []
  const audioRows: unknown[][] = []

  // Document order is the ANCHOR CHAIN, not the cell id: the head has a null
  // anchor and every later cell points at the one before it, per side and lane.
  // Skip this and the editor renders the file in whatever order it pleases,
  // which would make "go to the first unvalidated cell" untestable.
  const tail = new Map<string, string | null>()
  const linkTo = (chainKey: string, cellId: string): string | null => {
    const prev = tail.get(chainKey) ?? null
    tail.set(chainKey, cellId)
    return prev
  }

  for (const [fileId, books] of [[TEXT_FILE, TEXT_BOOKS], [AUDIO_FILE, AUDIO_BOOKS]] as const) {
    const ev = eventOf(fileId)
    for (const b of books) {
      for (const c of cellsFor(b)) {
        sourceRows.push([
          PROJECT_ID, fileId, c.cellId, "source", "", `Source ${c.cellId}`, c.type, c.ref,
          linkTo(`${fileId}|source|`, c.cellId), ev, "dev", NOW - 2 * DAY, 0, 0, 3,
        ])
        if (c.target !== "") {
          targetRows.push([
            PROJECT_ID, fileId, c.cellId, "target", "", c.target, null, null,
            linkTo(`${fileId}|target|`, c.cellId), ev, "dev", NOW - DAY,
            c.validated ? 1 : 0, c.validated ? VALIDATION_COUNT : 0, 3,
          ])
        }
        if (c.recorded) {
          audioRows.push([
            PROJECT_ID, fileId, c.cellId, `${c.cellId}-take1`, "take",
            `local://${c.cellId}.webm`, 1, 0, 0, ev, NOW - DAY, 2400,
          ])
        }
      }
    }
  }

  // A SECOND LANGUAGE on the text file, deliberately further behind. Switching
  // the lane tab must move books between groups while the target date, the Done
  // mark and the audio bar stay exactly where they were — audio has no lane.
  for (const b of TEXT_BOOKS.slice(0, 4)) {
    const half = Math.ceil(b.chapters / 2)
    for (const c of cellsFor(b)) {
      if (isStructural(c.type)) continue
      const chapter = Number(/\s(\d+):/.exec(c.ref)?.[1] ?? 0)
      if (chapter === 0 || chapter > half) continue
      const validated = chapter % 3 !== 0
      targetRows.push([
        PROJECT_ID, TEXT_FILE, c.cellId, "target", LANE2, `Tok Pisin ${c.cellId}`, null, null,
        linkTo(`${TEXT_FILE}|target|${LANE2}`, c.cellId), eventOf(TEXT_FILE), "dev", NOW - DAY,
        validated ? 1 : 0, validated ? VALIDATION_COUNT : 0, 3,
      ])
    }
  }

  // The MEDIA file. Its sections are five-minute time buckets, which nobody
  // plans by, so the inspector must say the file has no chapters rather than
  // draw an empty grid.
  const mediaRows: unknown[][] = []
  for (let i = 0; i < 40; i += 1) {
    const cellId = `MED-${i}`
    mediaRows.push([
      PROJECT_ID, MEDIA_FILE, cellId, "source", "", `Line ${i}`, "cue", null,
      linkTo(`${MEDIA_FILE}|source|`, cellId), eventOf(MEDIA_FILE), "dev", NOW - 2 * DAY,
      0, 0, 4, i * 30_000, i * 30_000 + 25_000,
    ])
    if (i < 34) {
      targetRows.push([
        PROJECT_ID, MEDIA_FILE, cellId, "target", "", `Zeile ${i}`, null, null,
        linkTo(`${MEDIA_FILE}|target|`, cellId), eventOf(MEDIA_FILE), "dev", NOW - DAY,
        i < 30 ? 1 : 0, i < 30 ? VALIDATION_COUNT : 0, 4,
      ])
    }
  }

  await insertRows(db, "cells", CELL_COLUMNS, sourceRows)
  await insertRows(db, "cells", [...CELL_COLUMNS, "start_ms", "end_ms"], mediaRows)
  await insertRows(db, "cells", CELL_COLUMNS, targetRows)
  await insertRows(db, "cell_audio",
    ["project_id", "file_id", "cell_id", "audio_id", "slot", "url", "selected",
     "deleted", "approved", "event_id", "created_ts", "duration_ms"], audioRows)

  // The PM's own marks. `plan_units` checks that done_at and done_by agree.
  const planRows = ALL_BOOKS
    .filter((b) => b.targetDateInDays !== undefined || b.doneDaysAgo !== undefined)
    .map((b) => [
      PROJECT_ID, fileOf(b.code), b.code,
      b.targetDateInDays === undefined ? null : dateIn(b.targetDateInDays),
      b.doneDaysAgo === undefined ? null : NOW - b.doneDaysAgo * DAY,
      b.doneDaysAgo === undefined ? null : "dev",
      NOW, "dev",
    ])
  await insertRows(db, "plan_units",
    ["project_id", "file_id", "section_key", "target_date", "done_at",
     "done_by", "updated_at", "updated_by"], planRows)

  // Who is on the hook.
  const assignmentCells: unknown[][] = []
  const assignmentRows: unknown[][] = []
  for (const a of ASSIGNMENTS) {
    const held = assignedCells(a)
    for (const c of held) assignmentCells.push([a.id, c.fileId, c.cellId])
    assignmentRows.push([
      a.id, PROJECT_ID, a.user, a.chapters.length > 0 ? "chapters" : "books",
      a.label, a.lane, held.length,
      a.deadlineInDays === null ? null : dateIn(a.deadlineInDays), OWNER, NOW,
    ])
  }
  await insertRows(db, "assignments",
    ["assignment_id", "project_id", "assignee_user_id", "scope_kind", "scope_label",
     "target_lang", "cells_total", "deadline", "created_by", "created_at"], assignmentRows)
  await insertRows(db, "assignment_cells",
    ["assignment_id", "file_id", "cell_id"], assignmentCells)

  // The projection, run exactly the way the sync worker runs it.
  for (const f of FILES) await db.batch(fullProgressRecomputeStmts(db, PROJECT_ID, f.id, NOW))

  console.log(
    `  ${sourceRows.length + mediaRows.length} source cells, ${targetRows.length} target cells, ` +
    `${audioRows.length} takes, ${assignmentRows.length} assignments ` +
    `over ${assignmentCells.length} cells, ${planRows.length} planned units`,
  )
}

// ───────────────────────── reading it back ─────────────────────────

interface BookRow {
  section_key: string
  total_count: number
  filled_count: number
  audio_count: number
  audio_validated_count: number
  structural_count: number
  structural_filled_count: number
  structural_audio_count: number
  structural_audio_validated_count: number
  validated_count: number
  structural_validated_count: number
}

/**
 * Check the projection against the fixture's own arithmetic, book by book.
 *
 * The counts the plan board reads are the raw row minus its structural share —
 * AQU-1083's policy applied as a subtraction, and since 0094 that includes the
 * AUDIO pair, so a recorded heading leaves the recordings exactly as the
 * heading leaves the cells. Validated is counted from the histogram the same
 * way `counts()` does: buckets at or above the project's validation count.
 */
async function verify(db: AquillaDb): Promise<boolean> {
  const rows = (await db.prepare(
    `SELECT p.section_key, p.total_count, p.filled_count, p.audio_count,
            p.audio_validated_count, p.structural_count, p.structural_filled_count,
            p.structural_audio_count, p.structural_audio_validated_count,
            COALESCE((SELECT SUM(value::int) FROM jsonb_each_text(p.validator_histogram)
                       WHERE key::int >= ?), 0)::int AS validated_count,
            COALESCE((SELECT SUM(value::int) FROM jsonb_each_text(p.structural_validator_histogram)
                       WHERE key::int >= ?), 0)::int AS structural_validated_count
       FROM file_section_progress p
      WHERE p.project_id = ? AND p.scope = 'book' AND p.target_lang = ''
      ORDER BY p.section_key`,
  ).bind(VALIDATION_COUNT, VALIDATION_COUNT, PROJECT_ID).all<BookRow>()).results

  const byCode = new Map(rows.map((r) => [r.section_key, r]))
  let ok = true

  console.log("\n  book   cells  filled   valid   audio   (the projection, headings excluded)")
  for (const b of ALL_BOOKS) {
    const r = byCode.get(b.code)
    if (!r) {
      console.log(`  ${b.code.padEnd(6)} MISSING — no book row in the projection`)
      ok = false
      continue
    }
    const got = {
      totalCount: Number(r.total_count) - Number(r.structural_count),
      filledCount: Number(r.filled_count) - Number(r.structural_filled_count),
      validatedCount: Number(r.validated_count) - Number(r.structural_validated_count),
      audioCount: Number(r.audio_count) - Number(r.structural_audio_count),
      audioValidatedCount:
        Number(r.audio_validated_count) - Number(r.structural_audio_validated_count),
    }
    const want = expectedCounts(b)
    const diffs = (Object.keys(want) as Array<keyof typeof want>)
      .filter((k) => want[k] !== got[k])
      .map((k) => `${k} ${got[k]} ≠ ${want[k]}`)
    if (diffs.length > 0) ok = false
    console.log(
      `  ${b.code.padEnd(6)}` +
      String(got.totalCount).padStart(5) +
      String(got.filledCount).padStart(8) +
      String(got.validatedCount).padStart(8) +
      String(got.audioCount).padStart(8) +
      (diffs.length > 0 ? `   ← ${diffs.join(", ")}` : ""),
    )
  }
  return ok
}

async function main(): Promise<void> {
  const url = process.env.AQUILLA_DATABASE_URL?.trim()
    || "postgresql://aquilla@localhost/aquilla_dev"
  const db = makePostgres(url, 1)
  try {
    console.log(`\nSeeding "${PROJECT_NAME}" (${PROJECT_ID}) into org ${ORG}…\n`)
    await seed(db)
    const ok = await verify(db)

    console.log("\n  what each row should say\n")
    const say = (name: string, text: string): void => {
      const words = text.replace(/\s+/g, " ").split(" ")
      const lines: string[] = []
      let line = ""
      for (const w of words) {
        if ((line + " " + w).trim().length > 74) { lines.push(line.trim()); line = w }
        else line += ` ${w}`
      }
      lines.push(line.trim())
      console.log(`  ${name}`)
      for (const l of lines) console.log(`      ${l}`)
      console.log("")
    }
    for (const b of ALL_BOOKS) say(`${b.code}  (${b.expect.replace("_", " ")})`, b.note)
    say("episode-03.vtt  (in progress)",
      "A media file. Its sections are five-minute time buckets rather than " +
      "chapters, so the inspector must say the file has no chapters instead of " +
      "drawing an empty grid.")
    say("production-notes.md  (not started)",
      "A file with no cells at all. A zero shortfall clears every threshold, so " +
      "without the total-count guard this would be promoted above In progress and " +
      "labelled 'Nothing left' — a file with nothing in it.")

    if (!ok) {
      console.error("  THE PROJECTION DISAGREES WITH THE FIXTURE — see the arrows above.\n")
      process.exitCode = 1
    } else {
      console.log("  The projection agrees with the fixture on every book.\n")
    }
  } finally {
    await db.close()
  }
}

void main()
