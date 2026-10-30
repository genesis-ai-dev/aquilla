#!/usr/bin/env tsx
// AQU-2125 — fold a project's line-by-line voice casting into one entry per
// character. Dry-run by default.
//
// A dubbing project cast from character sheets stored one cast entry per line,
// and one Come and See project reached 1.07 MB of settings — over the 1 MB cap
// (AQU-1943), so every casting save after that was refused. Every line already
// carries its character (`cells.metadata.cast_name`); this keeps one entry per
// character and only the lines cast differently from their character. Every
// line that had a voice keeps exactly that voice.
//
//   pnpm neon:fold-cast-by-character:dev
//   pnpm neon:fold-cast-by-character:dev -- --out /tmp/cast-fold-dev.json
//   pnpm neon:fold-cast-by-character:dev -- --apply --only <projectId>
//   pnpm neon:fold-cast-by-character:prod -- --only <projectId>
//   pnpm neon:fold-cast-by-character:prod -- --apply --production --only <projectId>
//
// --name-lines also reaches projects cast from a subtitle file's speaker tags,
// a spreadsheet's cast column or speaker detection before those imports wrote
// the speaker onto the line: each such line gets the name of the voice it is
// cast with as its character (a `cast.assign` event, as a character sheet
// writes), and is then folded. The dry run counts them and writes nothing.
//
// Do not pass --apply until a person has read the dry-run report. A line that
// names a character but was never given a voice (for example because its save
// was refused at the cap) picks up its character's voice; the report counts
// them, and --keep-uncast-lines keeps them voiceless instead. The fold lives in
// `src/lib/audio/character-cast.ts`, the SQL in
// `scripts/cast-by-character-fold.ts`, and both are unit-tested; this file is
// the I/O. The write goes through `patchProjectSettingsShared` — the same
// versioned door the app uses — so the version increments by exactly one and
// the change reaches open clients without a reload.
//
// Flags: --apply  --production  --only <id>  --limit <n>  --min-entries <n>
//        --keep-uncast-lines  --name-lines  --author <name>  --out <file>
//        --backup-dir <dir>  --as-user <id>
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { patchProjectSettingsShared } from "../db/shared/projects"
import { makeMaintenancePostgres } from "../db/shim/postgres"
import {
  decideFoldGate,
  listFoldCandidates,
  planProjectFold,
  settingsBackupPath,
  writeLineNames,
  PRODUCTION_FLAG,
  type ProjectFoldReport,
} from "./cast-by-character-fold"

const APPLY_COMMAND = "pnpm neon:fold-cast-by-character"
const DEFAULT_BACKUP_DIR = ".cast-fold-backups"

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
function writeBackup(dir: string, projectId: string, version: number, settings: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  const file = settingsBackupPath(dir, projectId, version, new Date())
  writeFileSync(file, JSON.stringify({ projectId, version, settings }, null, 2) + "\n")
  return file
}

function reportLine(r: ProjectFoldReport): string {
  return (
    `  ${r.projectId} ${r.projectName ?? "(unnamed)"}: cast entries ${r.entriesBefore} -> ${r.entriesAfter} ` +
    `(${r.characterEntries} characters added, ${r.droppedLineEntries} line entries dropped), ` +
    `${r.linesWithCharacter} lines name a character${r.linesToName ? ` (${r.linesToName} named from their voice)` : ""}, ` +
    `${r.newlyVoicedLines} newly voiced, ${r.markedLines} held voiceless, ` +
    `bytes ${r.settingsBytesBefore} -> ${r.settingsBytesAfter}, ` +
    `version ${r.versionBefore}${r.versionAfter === null ? " (unchanged)" : ` -> ${r.versionAfter}`}` +
    `${r.error ? ` — FAILED: ${r.error}` : ""}`
  )
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const production = process.argv.includes(PRODUCTION_FLAG)
  const keepUncastLines = process.argv.includes("--keep-uncast-lines")
  const nameLines = process.argv.includes("--name-lines")
  // Who the line-naming events are authored by, as a line's history shows it.
  const author = flagValue("--author") ?? "maintenance"
  const onlyProject = flagValue("--only")
  const outPath = flagValue("--out")
  const limit = positiveInt("--limit")
  const minEntries = positiveInt("--min-entries")
  const backupDir = path.resolve(flagValue("--backup-dir") ?? DEFAULT_BACKUP_DIR)
  const updatedBy = flagValue("--as-user") ?? "0"

  const gate = decideFoldGate({
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
    const candidates = await listFoldCandidates(db, { onlyProject, minEntries, limit })
    const reports: ProjectFoldReport[] = []
    if (onlyProject && candidates.length === 0) {
      console.log(`  ${onlyProject}: no cast map — untouched`)
    }

    for (const row of candidates) {
      const planned = await planProjectFold(db, row, { keepUncastLines, nameLines })
      if (!planned) {
        console.log(`  ${row.project_id}: nothing to fold (${row.entries} entries, none repeats its character) — untouched`)
        continue
      }
      const { report } = planned
      if (apply) {
        report.backupPath = writeBackup(backupDir, report.projectId, planned.version, planned.settings)
        console.log(`  backup: ${report.backupPath}`)
        if (planned.names.length > 0) {
          // Names first: the folded cast relies on them. A failure after this
          // leaves named lines and the old cast, which still speak the same;
          // re-running finds nothing left to name and finishes the fold.
          const named = await writeLineNames(db, report.projectId, planned.names, author)
          console.log(`  named ${named} line${named === 1 ? "" : "s"} from their voice`)
        }
        const written = await patchProjectSettingsShared(db, {
          projectId: report.projectId,
          ops: [{ key: "ttsSettings", value: planned.nextTts }],
          ifMatchVersion: planned.version,
          updatedBy,
          // AQU-1615: a maintenance write must never mint a lane out of the blob.
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

    const dropped = reports.reduce((n, r) => n + r.droppedLineEntries, 0)
    const bytesSaved = reports.reduce((n, r) => n + (r.settingsBytesBefore - r.settingsBytesAfter), 0)
    console.log(
      `${apply ? "APPLY" : "DRY RUN"}: ${dropped} line entr${dropped === 1 ? "y" : "ies"} folded on ${reports.length} project(s), ` +
        `${(bytesSaved / 1_000_000).toFixed(2)} MB of settings`,
    )
    for (const r of reports) console.log(reportLine(r))
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
