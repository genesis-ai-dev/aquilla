#!/usr/bin/env tsx
// Static CI check — no DB connection required.
//
// Asserts that every table declared in db/postgres/schema.sql has a
// corresponding CREATE TABLE statement somewhere in db/postgres/migrations/.
// Catches the class of drift where a table is added to schema.sql (or an
// auth-worker D1 migration) but never ported to the Neon migration set.
//
// Exits 1 with a list of offending tables if any are missing.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SCHEMA_FILE = path.join(REPO_ROOT, "db", "postgres", "schema.sql")
const MIGRATIONS_DIR = path.join(REPO_ROOT, "db", "postgres", "migrations")

// Tables that existed before the numbered migration convention started at 0028.
// These are in schema.sql but have no CREATE TABLE in any migration file —
// that's expected. Any table NOT in this set and NOT in a migration is a gap.
const PRE_MIGRATION_BASELINE = new Set([
  "users",
  "organizations",
  "org_members",
  "groups",
  "group_members",
  "password_reset_tokens",
  "activity_logs",
  "projects",
  "project_members",
  "group_project_grants",
  "project_invites",
  "project_settings",
  "events",
  "files",
  "cells",
  "cell_validators",
  "cell_waivers",
  "cell_audio",
  "cell_backtranslations",
  "comments",
  "assignments",
  "assignment_cells",
  "diarization_jobs",
  "file_source_blobs",
  "checkpoints",
])

function tableNames(sql: string): string[] {
  const names: string[] = []
  for (const line of sql.split("\n")) {
    const m = line
      .replace(/--.*$/, "")
      .trim()
      .match(/^CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z0-9_]*)/i)
    if (m) names.push(m[1].toLowerCase())
  }
  return names
}

const schemaSql = fs.readFileSync(SCHEMA_FILE, "utf8")
const schemaTableNames = tableNames(schemaSql)

const migrationsSql = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n")

const migrationTableNames = new Set(tableNames(migrationsSql))

const missing = schemaTableNames.filter(
  (t) => !migrationTableNames.has(t) && !PRE_MIGRATION_BASELINE.has(t),
)

if (missing.length === 0) {
  console.log(`✓ all ${schemaTableNames.length} tables in schema.sql have a migration`)
  process.exit(0)
} else {
  for (const t of missing) {
    console.error(`✗ table in schema.sql has no migration: ${t}`)
  }
  console.error(`\nFAIL — add a migration under db/postgres/migrations/ for each table above`)
  process.exit(1)
}
