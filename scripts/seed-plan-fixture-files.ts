#!/usr/bin/env tsx
/**
 * AQU-1278: seeds the two FILE-GRAIN plan-board fixtures — a subtitle project
 * and a document project — described by `src/lib/plan/plan-fixture-files.ts`.
 *
 *   AQUILLA_DATABASE_URL=postgresql://aquilla@localhost/aquilla_dev \
 *     ./node_modules/.bin/tsx scripts/seed-plan-fixture-files.ts
 *
 * IDEMPOTENT, like its Bible sibling: every run deletes both projects' rows and
 * rebuilds them; dates are relative to the run date. It touches nothing
 * outside the two project ids. Progress numbers come from the sync worker's
 * own recompute and are read back and checked against the fixture.
 */
import { makePostgres, type AquillaDb } from "../db/shim/postgres"
import { fullProgressRecomputeStmts } from "../sync-worker/src/events/progress-projection"
import {
  DOCS_ASSIGNMENTS, DOCS_FILES, DOCS_PROJECT_ID, DOCS_PROJECT_NAME, LANE2,
  VALIDATION_COUNT, VTT_ASSIGNMENTS, VTT_FILES, VTT_PROJECT_ID, VTT_PROJECT_NAME,
  assignedCells, cellsForFile, expectedCounts,
  type FixtureAssignment, type FixtureFile,
} from "../src/lib/plan/plan-fixture-files"

const ORG = 1
const OWNER = 1
const NOW = Date.now()
const DAY = 86_400_000
const dateIn = (days: number): string => new Date(NOW + days * DAY).toISOString().slice(0, 10)

/** One cue is ten seconds; five-minute buckets are what the projection keys by. */
const CUE_MS = 10_000

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
  "validated", "endorsement_count", "word_count", "start_ms", "end_ms",
]

interface Project {
  id: string
  name: string
  targetLanguage: string
  files: FixtureFile[]
  assignments: FixtureAssignment[]
  /** Which files also get a second-language copy of their cells, further behind. */
  secondLane: string[]
}

async function seedProject(db: AquillaDb, p: Project): Promise<void> {
  await db.prepare(
    "DELETE FROM assignment_cells WHERE assignment_id IN " +
    "(SELECT assignment_id FROM assignments WHERE project_id = ?)",
  ).bind(p.id).run()
  for (const table of [
    "cell_audio", "cells", "file_section_progress", "files", "plan_units",
    "assignments", "project_settings", "project_members", "events",
  ]) {
    await db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(p.id).run()
  }
  await db.prepare("DELETE FROM projects WHERE id = ?").bind(p.id).run()

  await db.prepare(
    "INSERT INTO projects (id, name, org_id, created_by, pm_user_id) VALUES (?, ?, ?, ?, ?)",
  ).bind(p.id, p.name, ORG, OWNER, OWNER).run()
  // Version 1, never 0: at 0 the client ignores the server's settings and the
  // UI loses the target language. See the Bible seeder's note.
  await db.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, ?)",
  ).bind(p.id, JSON.stringify({
    sourceLanguage: "English",
    targetLanguage: p.targetLanguage,
    targetLanes: [LANE2],
    validationCount: VALIDATION_COUNT,
  }), OWNER).run()
  await insertRows(db, "project_members",
    ["project_id", "user_id", "role_level", "granted_by"],
    ([[OWNER, 700], [2, 600], [3, 400], [50, 400]] as const)
      .map(([user, level]) => [p.id, user, level, OWNER]))

  const fileId = (f: FixtureFile) => `plan-1278-${f.id}`
  const eventOf = (f: FixtureFile) => `${p.id}-ev-${f.id}`
  await insertRows(db, "events",
    ["id", "schema_version", "project_id", "file_id", "kind", "author",
     "payload", "client_ts", "server_ts", "server_seq"],
    p.files.map((f, i) => [eventOf(f), 1, p.id, fileId(f), "file.create", "dev", "{}", NOW, NOW, i + 1]))
  await insertRows(db, "files",
    ["id", "project_id", "name", "kind", "event_id", "created_by",
     "created_at", "updated_at", "last_edit_at"],
    p.files.map((f) => [fileId(f), p.id, f.name, f.kind, eventOf(f), "dev", NOW, NOW, NOW - DAY]))

  const sourceRows: unknown[][] = []
  const targetRows: unknown[][] = []
  const audioRows: unknown[][] = []
  const tail = new Map<string, string | null>()
  const linkTo = (chain: string, cellId: string): string | null => {
    const prev = tail.get(chain) ?? null
    tail.set(chain, cellId)
    return prev
  }

  for (const f of p.files) {
    const isMedia = f.kind === "vtt"
    const type = isMedia ? "cue" : "text"
    for (const [i, c] of cellsForFile(f).entries()) {
      // A cue carries timestamps and no canonical ref; a document cell carries
      // neither. That is what makes both of these FILE-grain units with no
      // chapter grid — and the timestamps are what give a VTT file its
      // five-minute time-bucket sections.
      const start = isMedia ? i * CUE_MS : null
      const end = isMedia ? i * CUE_MS + CUE_MS - 1500 : null
      sourceRows.push([
        p.id, fileId(f), c.cellId, "source", "", `Source ${f.name} ${i + 1}`, type, null,
        linkTo(`${f.id}|source|`, c.cellId), eventOf(f), "dev", NOW - 2 * DAY, 0, 0, 4, start, end,
      ])
      if (c.target !== "") {
        targetRows.push([
          p.id, fileId(f), c.cellId, "target", "", c.target, null, null,
          linkTo(`${f.id}|target|`, c.cellId), eventOf(f), "dev", NOW - DAY,
          c.validated ? 1 : 0, c.validated ? VALIDATION_COUNT : 0, 4, null, null,
        ])
      }
      if (c.recorded) {
        audioRows.push([
          p.id, fileId(f), c.cellId, `${c.cellId}-take1`, "take",
          `local://${c.cellId}.webm`, 1, 0, 0, eventOf(f), NOW - DAY, 2400,
        ])
      }
      if (p.secondLane.includes(f.id) && i < Math.floor(f.cells / 2)) {
        // Half the file, every third cell unvalidated: a lane visibly behind.
        const validated = i % 3 !== 0
        targetRows.push([
          p.id, fileId(f), c.cellId, "target", LANE2, `Tok Pisin ${c.cellId}`, null, null,
          linkTo(`${f.id}|target|${LANE2}`, c.cellId), eventOf(f), "dev", NOW - DAY,
          validated ? 1 : 0, validated ? VALIDATION_COUNT : 0, 4, null, null,
        ])
      }
    }
  }
  await insertRows(db, "cells", CELL_COLUMNS, sourceRows)
  await insertRows(db, "cells", CELL_COLUMNS, targetRows)
  await insertRows(db, "cell_audio",
    ["project_id", "file_id", "cell_id", "audio_id", "slot", "url", "selected",
     "deleted", "approved", "event_id", "created_ts", "duration_ms"], audioRows)

  const planRows = p.files
    .filter((f) => f.targetDateInDays !== undefined || f.doneDaysAgo !== undefined)
    .map((f) => [
      p.id, fileId(f), "",
      f.targetDateInDays === undefined ? null : dateIn(f.targetDateInDays),
      f.doneDaysAgo === undefined ? null : NOW - f.doneDaysAgo * DAY,
      f.doneDaysAgo === undefined ? null : "dev",
      NOW, "dev",
    ])
  await insertRows(db, "plan_units",
    ["project_id", "file_id", "section_key", "target_date", "done_at",
     "done_by", "updated_at", "updated_by"], planRows)

  const assignmentRows: unknown[][] = []
  const assignmentCells: unknown[][] = []
  for (const a of p.assignments) {
    const file = p.files.find((f) => f.id === a.file)!
    const held = assignedCells(a, p.files)
    for (const cellId of held) assignmentCells.push([a.id, fileId(file), cellId])
    assignmentRows.push([
      a.id, p.id, a.user, a.range ? "cells" : "files", a.label, a.lane, held.length,
      a.deadlineInDays === null ? null : dateIn(a.deadlineInDays), OWNER, NOW,
    ])
  }
  await insertRows(db, "assignments",
    ["assignment_id", "project_id", "assignee_user_id", "scope_kind", "scope_label",
     "target_lang", "cells_total", "deadline", "created_by", "created_at"], assignmentRows)
  await insertRows(db, "assignment_cells",
    ["assignment_id", "file_id", "cell_id"], assignmentCells)

  for (const f of p.files) await db.batch(fullProgressRecomputeStmts(db, p.id, fileId(f), NOW))

  console.log(
    `  ${p.name}: ${sourceRows.length} source cells, ${targetRows.length} target cells, ` +
    `${audioRows.length} takes, ${assignmentRows.length} assignments, ${planRows.length} planned units`,
  )
}

interface FileRow {
  file_id: string
  total_count: number
  filled_count: number
  audio_count: number
  audio_validated_count: number
  validated_count: number
}

async function verify(db: AquillaDb, p: Project): Promise<boolean> {
  const rows = (await db.prepare(
    `SELECT p.file_id, p.total_count, p.filled_count, p.audio_count, p.audio_validated_count,
            COALESCE((SELECT SUM(value::int) FROM jsonb_each_text(p.validator_histogram)
                       WHERE key::int >= ?), 0)::int AS validated_count
       FROM file_section_progress p
      WHERE p.project_id = ? AND p.scope = 'file' AND p.target_lang = ''`,
  ).bind(VALIDATION_COUNT, p.id).all<FileRow>()).results
  const byFile = new Map(rows.map((r) => [r.file_id, r]))
  let ok = true
  console.log(`\n  ${p.name}\n  file                     cells  filled   valid   audio`)
  for (const f of p.files) {
    const r = byFile.get(`plan-1278-${f.id}`)
    if (!r) { console.log(`  ${f.name.padEnd(24)} MISSING`); ok = false; continue }
    const got = {
      totalCount: Number(r.total_count), filledCount: Number(r.filled_count),
      validatedCount: Number(r.validated_count), audioCount: Number(r.audio_count),
      audioValidatedCount: Number(r.audio_validated_count),
    }
    const want = expectedCounts(f)
    const diffs = (Object.keys(want) as Array<keyof typeof want>)
      .filter((k) => want[k] !== got[k]).map((k) => `${k} ${got[k]} ≠ ${want[k]}`)
    if (diffs.length > 0) ok = false
    console.log(
      `  ${f.name.padEnd(24)}${String(got.totalCount).padStart(5)}${String(got.filledCount).padStart(8)}` +
      `${String(got.validatedCount).padStart(8)}${String(got.audioCount).padStart(8)}` +
      (diffs.length > 0 ? `   ← ${diffs.join(", ")}` : ""),
    )
  }
  return ok
}

async function main(): Promise<void> {
  const url = process.env.AQUILLA_DATABASE_URL?.trim() || "postgresql://aquilla@localhost/aquilla_dev"
  const db = makePostgres(url, 1)
  const projects: Project[] = [
    { id: VTT_PROJECT_ID, name: VTT_PROJECT_NAME, targetLanguage: "German",
      files: VTT_FILES, assignments: VTT_ASSIGNMENTS, secondLane: ["s1e1", "s1e2", "s2e1"] },
    { id: DOCS_PROJECT_ID, name: DOCS_PROJECT_NAME, targetLanguage: "French",
      files: DOCS_FILES, assignments: DOCS_ASSIGNMENTS, secondLane: ["route", "briefing"] },
  ]
  try {
    console.log(`\nSeeding two file-grain plan fixtures into org ${ORG}…\n`)
    let ok = true
    for (const p of projects) {
      await seedProject(db, p)
      ok = (await verify(db, p)) && ok
      console.log("\n  what each row should say\n")
      for (const f of p.files) console.log(`  ${f.name}  (${f.expect.replace("_", " ")})\n      ${f.note}\n`)
    }
    if (!ok) { console.error("  THE PROJECTION DISAGREES WITH THE FIXTURE — see the arrows above.\n"); process.exitCode = 1 }
    else console.log("  The projection agrees with both fixtures on every file.\n")
  } finally {
    await db.close()
  }
}

void main()
