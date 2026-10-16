#!/usr/bin/env tsx
// AQU-1941 — strip verse-named phantom voices (and the cast assignments that
// point at them) out of migrated projects' TTS settings. Dry-run by default.
//
// The Codex migration's cast step read every Codex cell label as a speaker, and
// for a Bible cell that label is the verse. Migrations run before the AQU-813
// guard (2026-08-07) therefore minted one Voice per verse:
// `iloko_ilo_the_chosen` carries 31,287 voices, 117 of them the real cast, and
// 36,860 cast assignments — a 5.45 MB settings blob that every member fetches
// on every workspace open and every window focus.
//
//   pnpm neon:prune-phantom-voices:dev
//   pnpm neon:prune-phantom-voices:dev -- --out /tmp/phantom-voices-dev.json
//   pnpm neon:prune-phantom-voices:dev -- --apply --only <projectId>
//   pnpm neon:prune-phantom-voices:prod -- --out /tmp/phantom-voices-prod.json
//   pnpm neon:prune-phantom-voices:prod -- --apply --production --only <projectId>
//
// Do not pass --apply until a person has read the dry-run report. The keep rules
// live in `src/lib/audio/phantom-voices.ts`, the gate and the SQL in
// `scripts/phantom-voice-prune.ts`, and both are unit-tested; this file is the
// I/O. The write goes through `patchProjectSettingsShared` — the same versioned
// door the app uses — so the version increments by exactly one and the change
// reaches open clients without a reload.
//
// Flags: --apply  --production  --only <id>  --limit <n>  --out <file>
//        --backup-dir <dir>  --as-user <id>
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { patchProjectSettingsShared } from "../db/shared/projects"
import { makeMaintenancePostgres } from "../db/shim/postgres"
import {
  decidePruneGate,
  listPruneCandidates,
  planProjectPrune,
  settingsBackupPath,
  PRODUCTION_FLAG,
  type ProjectPruneReport,
} from "./phantom-voice-prune"

const APPLY_COMMAND = "pnpm neon:prune-phantom-voices"
const DEFAULT_BACKUP_DIR = ".phantom-voice-backups"

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || "neondb"
  const role = process.env.NEON_PG_ROLE?.trim() || "neondb_owner"
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error("NEON_PG_HOST and NEON_PG_PASSWORD are required")
  const url = new URL("postgresql://placeholder")
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set("sslmode", "require")
  return url.toString()
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function positiveInt(name: string): number | undefined {
  const raw = flagValue(name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

/** The pre-write copy, written before the settings row is touched. */
function writeBackup(
  dir: string,
  projectId: string,
  version: number,
  settings: Record<string, unknown>,
): string {
  mkdirSync(dir, { recursive: true })
  const file = settingsBackupPath(dir, projectId, version, new Date())
  writeFileSync(file, JSON.stringify({ projectId, version, settings }, null, 2) + "\n")
  return file
}

function reportLine(r: ProjectPruneReport): string {
  return (
    `  ${r.projectId} ${r.projectName ?? "(unnamed)"}: voices ${r.totalVoices} ` +
    `(${r.versePhantomVoices} verse-named, ${r.keptVoices} kept), ` +
    `assignments ${r.assignmentsToDrop}/${r.totalAssignments} to drop, ` +
    `bytes ${r.settingsBytesBefore} -> ${r.settingsBytesAfter}, ` +
    `version ${r.versionBefore}${r.versionAfter === null ? " (unchanged)" : ` -> ${r.versionAfter}`}` +
    `${r.error ? ` — FAILED: ${r.error}` : ""}`
  )
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const production = process.argv.includes(PRODUCTION_FLAG)
  const onlyProject = flagValue("--only")
  const outPath = flagValue("--out")
  const limit = positiveInt("--limit")
  const backupDir = path.resolve(flagValue("--backup-dir") ?? DEFAULT_BACKUP_DIR)
  const updatedBy = flagValue("--as-user") ?? "0"

  const gate = decidePruneGate({
    apply,
    production,
    target: process.env.AQUILLA_NEON_TARGET?.trim() || undefined,
    localUrl: process.env.AQUILLA_LOCAL_PG_URL?.trim() || undefined,
    applyCommand: APPLY_COMMAND,
  })
  if (gate.kind === "refuse") {
    console.error(gate.message)
    process.exit(1)
  }
  if (gate.note) console.log(gate.note)

  const db = makeMaintenancePostgres(connectionString(), 1)
  try {
    const candidates = await listPruneCandidates(db, { onlyProject, limit })
    const reports: ProjectPruneReport[] = []
    if (onlyProject && candidates.length === 0) {
      // --only names one project and the operator is owed an answer about it.
      // Without --only, the projects the prefilter skipped are the normal case
      // and printing each one would bury the report.
      console.log(`  ${onlyProject}: clean (no reference-named voices) — untouched`)
    }

    for (const row of candidates) {
      const planned = await planProjectPrune(db, row)
      if (!planned) {
        console.log(`  ${row.project_id}: clean (no verse-named voices survive the keep rules) — untouched`)
        continue
      }
      const { report } = planned
      if (apply) {
        report.backupPath = writeBackup(backupDir, report.projectId, planned.version, planned.settings)
        console.log(`  backup: ${report.backupPath}`)
        const written = await patchProjectSettingsShared(db, {
          projectId: report.projectId,
          ops: [{ key: "ttsSettings", value: planned.nextTts }],
          ifMatchVersion: planned.version,
          updatedBy,
          // AQU-1615: a maintenance write must never mint a lane out of the blob.
          registerLanes: false,
        })
        if (written.status === "ok") {
          report.applied = true
          report.versionAfter = written.settings.version
        } else {
          report.error =
            written.status === "conflict"
              ? `version moved to ${written.current.version} while we were reading — re-run`
              : written.message
        }
      }
      reports.push(report)
    }

    const totalDropped = reports.reduce((n, r) => n + r.versePhantomVoices, 0)
    const bytesSaved = reports.reduce((n, r) => n + (r.settingsBytesBefore - r.settingsBytesAfter), 0)
    console.log(
      `${apply ? "APPLY" : "DRY RUN"}: ${totalDropped} verse-named voice(s) on ${reports.length} project(s), ` +
        `${(bytesSaved / 1_000_000).toFixed(2)} MB of settings`,
    )
    for (const r of reports) {
      console.log(reportLine(r))
      if (r.sampleDroppedNames.length) console.log(`      e.g. ${r.sampleDroppedNames.join(", ")}`)
    }
    if (!apply && reports.length > 0) {
      console.log("nothing was written. Re-run with --apply --only <projectId> once this report is read.")
    }
    if (outPath) {
      writeFileSync(outPath, JSON.stringify({ mode: apply ? "apply" : "dry-run", reports }, null, 2) + "\n")
      console.log(`wrote ${outPath}`)
    }
    if (reports.some((r) => r.error)) process.exitCode = 1
  } finally {
    await db.close?.()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
