// The events replay gate (docs/RELEASE-RISK-GATES.md, "Replay gate").
//
// A corpus entry is one project's event log plus the rows the rebuild reads
// beside it (lanes, chain_claims, project_seq_counters). The
// gate seeds those into a fresh PGlite, runs the production rebuild endpoint
// from genesis, and hashes every projection table it produced. A PR that
// changes what the events project to changes a hash; the committed golden
// (replay-corpus/golden.json) is what the hash is compared with, so the
// golden's diff IS the human-reviewable "intentional change" artifact.
//
// Real corpora carry client text, so they live in the private R2 bucket and
// are fetched into replay-corpus/cache/ (gitignored) by
// `node scripts/replay-corpus.mjs fetch`. The synthetic corpora under
// replay-corpus/synthetic/ are committed so the harness always runs.
import { PGlite } from "@electric-sql/pglite"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { handleRebuildProjectionRequest } from "../../events/rebuild"
import { makeTestDb, type Seed } from "./pg-test-db"

export const CORPUS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../replay-corpus")

/** Rows the rebuild reads but never writes as projection: seeded, not hashed.
 *  `events` is the log itself. No `projects` row: nothing in the replay reads
 *  it, it carries user foreign keys, and its name identifies the client. */
export const INPUT_TABLES = ["lanes", "project_seq_counters", "chain_claims", "events"] as const

/** Every table buildEventProjectionStmts / the progress recompute can land a
 *  row in (ProjectionTouches in event-projection.ts, plus the progress
 *  table). A new projection target must be added here or the gate is blind
 *  to it; replay-corpus.test.ts pins the list against the live code. */
export const OUTPUT_TABLES = [
  "cells",
  "cell_validators",
  "cell_waivers",
  "files",
  "file_section_progress",
  "cell_audio",
  "cell_audio_validators",
  "cell_attachments",
  "comments",
  "cell_backtranslations",
  "cell_glosses",
  "cell_links",
  "cell_word_morph",
  "concepts",
  // AQU-2308: hand-set navigator milestones (file.milestone.set / .remove).
  "file_milestones",
] as const

/** Columns whose value is the wall clock or a derived index, not the log. */
const VOLATILE_COLUMNS = new Set(["created_at", "updated_at", "value_tsv"])

export interface CorpusEntry {
  slug: string
  /** `synthetic` is committed under replay-corpus/synthetic; `r2` is fetched
   *  into replay-corpus/cache by scripts/replay-corpus.mjs. */
  source: "synthetic" | "r2"
  file: string
  sha256: string
  events: number
  maxSeq: number
  capturedAt: string
}

export interface CorpusManifest {
  format: 1
  projects: CorpusEntry[]
}

export type CorpusRows = Partial<Record<(typeof INPUT_TABLES)[number], Array<Record<string, unknown>>>>

export interface TableDigest {
  rows: number
  sha256: string
}

export type ProjectDigest = Record<string, TableDigest>
export type Golden = Record<string, ProjectDigest>

export function readManifest(): CorpusManifest {
  return JSON.parse(readFileSync(path.join(CORPUS_DIR, "manifest.json"), "utf8")) as CorpusManifest
}

export function readGolden(): Golden {
  const file = path.join(CORPUS_DIR, "golden.json")
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Golden) : {}
}

export function corpusPath(entry: CorpusEntry): string {
  return path.join(CORPUS_DIR, entry.source === "synthetic" ? "synthetic" : "cache", entry.file)
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** Loads one corpus file and checks it is the bytes the manifest pinned, so
 *  a golden can never be compared against a corpus that drifted. */
export function loadCorpus(entry: CorpusEntry): CorpusRows {
  const text = readFileSync(corpusPath(entry), "utf8")
  const actual = sha256Hex(text)
  if (actual !== entry.sha256) {
    throw new Error(`${entry.file}: sha256 ${actual} does not match manifest ${entry.sha256}; re-run the export or fix the manifest`)
  }
  return JSON.parse(text) as CorpusRows
}

/** The project a corpus describes, read off its own log: the manifest
 *  deliberately carries no production project id. */
export function corpusProjectId(corpus: CorpusRows): string {
  const id = corpus.events?.[0]?.project_id
  if (typeof id !== "string" || !id) throw new Error("corpus has no events, so no project id")
  return id
}

/** JSONB columns come out of the exporter as objects; PGlite binds them as
 *  JSON text. Everything else (TEXT payloads, ISO timestamps, numbers) binds
 *  as is. */
function bindable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value
  }
  return out
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Date) return value.toISOString()
  return value
}

/** Rows as a stable string: volatile columns dropped, keys sorted, rows
 *  sorted by their own JSON. Same engine on every run, so byte-stable. */
export function canonicalRows(rows: Array<Record<string, unknown>>): string {
  const clean = rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(row).sort()) {
      if (VOLATILE_COLUMNS.has(key)) continue
      out[key] = canonicalValue(row[key])
    }
    return JSON.stringify(out)
  })
  clean.sort()
  return clean.join("\n")
}

/** Table → the columns it has in some schema.sql. */
export type SchemaColumns = Record<string, string[]>

/** The columns every projection table has in a schema.sql, read off a real
 *  catalog and not parsed out of the text: schema.sql declares some columns
 *  in CREATE TABLE and adds others with ALTER TABLE further down. */
export async function schemaColumns(schemaSql: string): Promise<SchemaColumns> {
  const pg = new PGlite()
  try {
    await pg.exec(schemaSql)
    const result = await pg.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name, column_name`,
      [[...OUTPUT_TABLES]],
    )
    const columns: SchemaColumns = {}
    for (const row of result.rows) (columns[row.table_name] ??= []).push(row.column_name)
    return columns
  } finally {
    await pg.close()
  }
}

export interface ReplayOptions {
  /** The migration gate's "old code, new schema" leg (risk-label.yml
   *  `migration-gate`, REPLAY_BASELINE_SCHEMA): the columns the BASE commit's
   *  schema.sql has. Only these are hashed, so a column the migration adds,
   *  which the base commit's code cannot read or write, is left out of the
   *  comparison with the base commit's golden. Everything that code can know
   *  about is still compared: a value in one of its columns, a row count,
   *  and a baseline column the new schema no longer has fails outright.
   *  Unset (the replay gate, the deps gate, a local run): every column is
   *  hashed, which is what golden.json was written from. */
  baselineColumns?: SchemaColumns
  /** SQL run after the corpus is seeded and before the rebuild: a migration
   *  landing on a live database, with this build's code then running on it.
   *  For the tests that pin what the baseline leg ignores and what it does
   *  not. */
  migration?: string
}

export interface ReplayResult {
  digest: ProjectDigest
  /** Canonical rows per table, for writing out when a digest differs. */
  tables: Record<string, string>
  rebuild: Record<string, unknown>
  /** `table.column` for every column left out of the hash because the
   *  baseline schema does not have it. Empty without a baseline. */
  ignoredColumns: string[]
}

/** One table's rows for the hash. With a baseline, the baseline's columns
 *  are selected by name, so a dropped or renamed one is an error here even
 *  on a table with no rows, where a hash could not tell. */
async function projectionRows(
  pg: PGlite,
  table: string,
  projectId: string,
  baselineColumns: SchemaColumns | undefined,
): Promise<{ rows: Array<Record<string, unknown>>; ignored: string[] }> {
  if (!baselineColumns) {
    const result = await pg.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE project_id = $1`, [projectId])
    return { rows: result.rows, ignored: [] }
  }
  const baseline = baselineColumns[table]
  if (!baseline?.length) throw new Error(`${table}: the baseline schema has no such table, so there is nothing to compare its rows with`)
  const live = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )
  const present = new Set(live.rows.map((row) => row.column_name))
  const gone = baseline.filter((column) => !present.has(column))
  if (gone.length) {
    throw new Error(
      `${table}: the baseline schema has ${gone.join(", ")} and the new schema does not. ` +
        "The base commit's code reads and writes that column; dropping or renaming it is not additive.",
    )
  }
  const known = new Set(baseline)
  const ignored = [...present].filter((column) => !known.has(column)).sort().map((column) => `${table}.${column}`)
  const list = baseline.map((column) => `"${column}"`).join(", ")
  const result = await pg.query<Record<string, unknown>>(`SELECT ${list} FROM ${table} WHERE project_id = $1`, [projectId])
  return { rows: result.rows, ignored }
}

/** Seeds the corpus into a fresh database, replays it through the production
 *  rebuild endpoint (from genesis: no SNAPSHOTS binding), and digests every
 *  projection table. */
export async function replayCorpus(projectId: string, corpus: CorpusRows, options: ReplayOptions = {}): Promise<ReplayResult> {
  const seed: Seed = {}
  for (const table of INPUT_TABLES) {
    const rows = corpus[table]
    if (rows?.length) seed[table] = rows.map(bindable)
  }
  const testDb = await makeTestDb(seed)
  try {
    if (options.migration) await testDb.pg.exec(options.migration)
    const secret = "replay-corpus"
    const response = await handleRebuildProjectionRequest(
      new Request(`https://worker/admin/projects/${encodeURIComponent(projectId)}/rebuild-projection?fullReplay=1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      }),
      { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: secret },
    )
    if (!response || response.status !== 200) {
      throw new Error(`rebuild failed: HTTP ${response?.status ?? "null"} ${response ? await response.text() : ""}`)
    }
    const rebuild = (await response.json()) as Record<string, unknown>
    const digest: ProjectDigest = {}
    const tables: Record<string, string> = {}
    const ignoredColumns: string[] = []
    for (const table of OUTPUT_TABLES) {
      const { rows, ignored } = await projectionRows(testDb.pg, table, projectId, options.baselineColumns)
      const canonical = canonicalRows(rows)
      tables[table] = canonical
      digest[table] = { rows: rows.length, sha256: sha256Hex(canonical) }
      ignoredColumns.push(...ignored)
    }
    return { digest, tables, rebuild, ignoredColumns }
  } finally {
    await testDb.close()
  }
}

/** The tables whose digest differs, each with the two counts. */
export function diffDigest(expected: ProjectDigest | undefined, actual: ProjectDigest): string[] {
  const lines: string[] = []
  for (const table of Object.keys(actual).sort()) {
    const want = expected?.[table]
    const got = actual[table]
    if (!want) lines.push(`${table}: no golden (rows=${got.rows})`)
    else if (want.sha256 !== got.sha256) lines.push(`${table}: rows ${want.rows} -> ${got.rows}, hash changed`)
  }
  return lines
}
