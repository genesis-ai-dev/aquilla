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
import { readPlanUnitsSql, type PlanUnitRow } from "../db/shared/plan-units"
import {
  DOCS_ASSIGNMENTS, DOCS_FILES, DOCS_PROJECT_ID, DOCS_PROJECT_NAME, LANE2,
  VALIDATION_COUNT, VTT_ASSIGNMENTS, VTT_FILES, VTT_PROJECT_ID, VTT_PROJECT_NAME,
  assignedCells, cellsForFile, cueSheetId, cuesForFile, expectedCounts, linksForFile,
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
    "cell_audio", "cell_links", "cells", "file_section_progress", "files", "plan_units",
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
  const sheetId = (f: FixtureFile) => cueSheetId(fileId(f))
  const eventOf = (f: FixtureFile) => `${p.id}-ev-${f.id}`
  const sheetEventOf = (f: FixtureFile) => `${p.id}-ev-${f.id}-cues`
  /** The episodes somebody is dubbing: each gets a hidden audio-cue sibling. */
  const sheeted = p.files.filter((f) => f.cues !== undefined)

  // THE CUE SHEET, as `src/lib/import/audio-vtt.ts` writes one: its own file,
  // named after the anchor, `role: 'audio-cues'` as the discriminator, `kind`
  // still 'vtt' so nothing has to learn a new file type, and `anchor_file_id`
  // pointing back at the episode. It never appears in a file list and it is
  // never a planning unit — the board reads THROUGH it for the takes.
  await insertRows(db, "events",
    ["id", "schema_version", "project_id", "file_id", "kind", "author",
     "payload", "client_ts", "server_ts", "server_seq"],
    [
      ...p.files.map((f, i) =>
        [eventOf(f), 1, p.id, fileId(f), "file.create", "dev", "{}", NOW, NOW, i + 1]),
      ...sheeted.map((f, i) =>
        [sheetEventOf(f), 1, p.id, sheetId(f), "file.create", "dev", "{}", NOW, NOW,
         p.files.length + i + 1]),
    ])
  const FILE_COLUMNS = [
    "id", "project_id", "name", "kind", "role", "anchor_file_id", "meta", "cell_count",
    "event_id", "created_by", "created_at", "updated_at", "last_edit_at",
  ]
  await insertRows(db, "files", FILE_COLUMNS, [
    ...p.files.map((f) => [
      fileId(f), p.id, f.name, f.kind, null, null,
      // Episodes sit in a season folder, as The Chosen's do: the board's
      // in-order arrangement groups by it.
      JSON.stringify(f.kind === "vtt"
        ? { orderedBy: "time", importFormat: "vtt", corpusMarker: f.id.startsWith("s2") ? "Season 2" : "Season 1" }
        : {}),
      f.cells, eventOf(f), "dev", NOW, NOW, NOW - DAY,
    ]),
    ...sheeted.map((f) => [
      sheetId(f), p.id, `${f.name} · audio cues`, "vtt", "audio-cues", fileId(f),
      JSON.stringify({
        orderedBy: "time",
        importFormat: "vtt",
        aquillaImport: {
          audioVtt: { sourceFileName: `${f.id}_audio_timestamps.vtt`, cueCount: f.cues },
        },
      }),
      f.cues, sheetEventOf(f), "dev", NOW, NOW, NOW - DAY,
    ]),
  ])

  const sourceRows: unknown[][] = []
  const targetRows: unknown[][] = []
  const audioRows: unknown[][] = []
  const tail = new Map<string, string | null>()
  const linkTo = (chain: string, cellId: string): string | null => {
    const prev = tail.get(chain) ?? null
    tail.set(chain, cellId)
    return prev
  }

  const linkRows: unknown[][] = []

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

    // The sheet's own cues, and the takes ON THEM. A take never touches the
    // subtitle file: that is the fact the board had to be taught, and seeding
    // it any other way is what made the first version of this fixture prove
    // nothing. Cues are longer than subtitle lines — a line of speech against a
    // line of reading — which is why there are fewer of them.
    for (const [i, cue] of cuesForFile(f).entries()) {
      const span = Math.round((f.cells / (f.cues ?? 1)) * CUE_MS)
      sourceRows.push([
        p.id, sheetId(f), cue.cellId, "source", "", `Cue ${f.name} ${i + 1}`, "cue", null,
        linkTo(`${f.id}|cues|`, cue.cellId), sheetEventOf(f), "dev", NOW - 2 * DAY,
        0, 0, 4, i * span, i * span + span - 1500,
      ])
      if (cue.recorded) {
        audioRows.push([
          p.id, sheetId(f), cue.cellId, `${cue.cellId}-take1`, "take",
          `local://${cue.cellId}.webm`, 1, 0, 0, sheetEventOf(f), NOW - DAY, 2400,
        ])
      }
    }
    for (const l of linksForFile(f)) {
      linkRows.push([
        p.id, "text-audio", fileId(f), l.from, sheetId(f), l.to, 1, "auto", null,
        sheetEventOf(f), NOW - DAY,
      ])
    }
  }
  await insertRows(db, "cells", CELL_COLUMNS, sourceRows)
  await insertRows(db, "cells", CELL_COLUMNS, targetRows)
  await insertRows(db, "cell_audio",
    ["project_id", "file_id", "cell_id", "audio_id", "slot", "url", "selected",
     "deleted", "approved", "event_id", "created_ts", "duration_ms"], audioRows)
  await insertRows(db, "cell_links",
    ["project_id", "kind", "from_file_id", "from_cell_id", "to_file_id", "to_cell_id",
     "linked", "origin", "confidence", "event_id", "created_ts"], linkRows)

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

  // The sheets recompute too, or the takes exist in `cell_audio` and in no
  // projection row — and the board reads projection rows.
  for (const f of p.files) await db.batch(fullProgressRecomputeStmts(db, p.id, fileId(f), NOW))
  for (const f of sheeted) await db.batch(fullProgressRecomputeStmts(db, p.id, sheetId(f), NOW))

  console.log(
    `  ${p.name}: ${sourceRows.length} source cells (${sheeted.length} cue sheets), ` +
    `${targetRows.length} target cells, ${audioRows.length} takes, ` +
    `${linkRows.length} text-audio links, ${assignmentRows.length} assignments, ` +
    `${planRows.length} planned units`,
  )
}

/** Cells endorsed by at least the project's threshold, out of the histogram. */
function validatedFrom(histogram: Record<string, number> | string | null): number {
  const h: Record<string, number> =
    typeof histogram === "string" ? JSON.parse(histogram || "{}") : (histogram ?? {})
  return Object.entries(h)
    .filter(([endorsements]) => Number(endorsements) >= VALIDATION_COUNT)
    .reduce((sum, [, cells]) => sum + Number(cells), 0)
}

/**
 * Read the fixture back THROUGH THE BOARD'S OWN QUERY, not through the
 * projection rows underneath it.
 *
 * `readPlanUnitsSql` is what the plan route runs, so this checks the cue-sheet
 * fold as well as the projection: that the sheet is not a unit of its own, that
 * its takes surface on the episode, and that they arrive with the sheet's
 * denominator rather than the episode's cell count.
 */
async function verify(db: AquillaDb, p: Project): Promise<boolean> {
  const rows = (await db.prepare(readPlanUnitsSql()).bind(p.id, "").all<PlanUnitRow>()).results ?? []
  const byFile = new Map(rows.map((r) => [r.file_id, r]))
  let ok = true
  if (rows.length !== p.files.length) {
    console.log(`\n  ${rows.length} units for ${p.files.length} files — a cue sheet became a row`)
    ok = false
  }
  console.log(`\n  ${p.name}\n  file                     cells  filled   valid   audio   of`)
  for (const f of p.files) {
    const r = byFile.get(`plan-1278-${f.id}`)
    if (!r) { console.log(`  ${f.name.padEnd(24)} MISSING`); ok = false; continue }
    const got = {
      totalCount: Number(r.total_count), filledCount: Number(r.filled_count),
      validatedCount: validatedFrom(r.validator_histogram),
      audioCount: Number(r.audio_count),
      audioValidatedCount: Number(r.audio_validated_count),
      audioTotalCount: r.audio_total_count == null ? null : Number(r.audio_total_count),
    }
    const want = expectedCounts(f)
    const diffs = (Object.keys(want) as Array<keyof typeof want>)
      .filter((k) => want[k] !== got[k]).map((k) => `${k} ${got[k]} ≠ ${want[k]}`)
    if (diffs.length > 0) ok = false
    console.log(
      `  ${f.name.padEnd(24)}${String(got.totalCount).padStart(5)}${String(got.filledCount).padStart(8)}` +
      `${String(got.validatedCount).padStart(8)}${String(got.audioCount).padStart(8)}` +
      `${(got.audioTotalCount == null ? "—" : String(got.audioTotalCount)).padStart(6)}` +
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
