#!/usr/bin/env tsx
// AQU-2658 — put back the source cells a metadata merge damaged. Dry-run by default.
//
// Until AQU-2658 a metadata patch merged into a link-mirrored cell's envelope
// (stored as a JSON string) built the array `["<envelope json>", {}]`, and the
// cell lost its IDML locator: the file's InDesign export stopped on "has no
// supported IDML v2 locator". "Place translations" did it to every validated
// line it placed. The projection no longer does; this repairs the rows it left.
//
// It writes one thing: `metadata = metadata -> 0`, the value the row held before
// the merge, and only where the rest of the array is nothing but empty patches.
// Any other array is reported and left alone. It never deletes, and a second
// apply writes nothing. See db/shared/cell-metadata-repair.ts.
//
//   pnpm neon:repair-cell-metadata:dev
//   pnpm neon:repair-cell-metadata:prod -- --only <projectId>
//   pnpm neon:repair-cell-metadata:prod -- --only <projectId> --out /tmp/cell-metadata-prod.json
//   pnpm neon:repair-cell-metadata:prod -- --apply --production --only <projectId>
//
// Without --only the dry run reads every source cell in the database: a few
// minutes on production. Do not pass --apply until a person has read the
// dry-run report. People with the file open reload to see the repaired cells.
//
// Flags: --apply  --production  --only <projectId>  --out <file>
import { writeFileSync } from "node:fs"
import {
  listDamagedCellMetadata,
  restoreDamagedCellMetadata,
  type DamagedCellMetadataFile,
} from "../db/shared/cell-metadata-repair"
import { makeMaintenancePostgres } from "../db/shim/postgres"
import { decidePruneGate, PRODUCTION_FLAG } from "./phantom-voice-prune"

const APPLY_COMMAND = "pnpm neon:repair-cell-metadata"

interface FileReport extends DamagedCellMetadataFile {
  /** Cells this run wrote. Null on a dry run. */
  restored: number | null
  /** Arrays still there afterwards (a dry run: the ones it would leave). */
  leftAlone: number
}

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
  const value = i >= 0 ? process.argv[i + 1] : undefined
  if (i >= 0 && (value === undefined || value.startsWith("--"))) throw new Error(`${name} needs a value`)
  return value
}

function fileLine(report: FileReport): string {
  const where = `${report.projectName ?? "(unnamed project)"} / ${report.fileName ?? "(unnamed file)"}`
  const outcome = report.restored === null
    ? `${report.restorable} can be put back`
    : `${report.restored} put back`
  return (
    `  ${where}: ${report.damaged} damaged, ${outcome}` +
    `${report.leftAlone > 0 ? `, ${report.leftAlone} left alone (not the shape an empty patch leaves)` : ""}\n` +
    `    project ${report.projectId}  file ${report.fileId}`
  )
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const production = process.argv.includes(PRODUCTION_FLAG)
  const onlyProject = flagValue("--only")
  const outPath = flagValue("--out")

  const gate = decidePruneGate({
    apply,
    production,
    target: process.env.AQUILLA_NEON_TARGET?.trim() || undefined,
    localUrl: process.env.AQUILLA_LOCAL_PG_URL?.trim() || undefined,
    applyCommand: APPLY_COMMAND,
    action: "restore cell metadata",
    productionNote: "Each cell is put back to the value it held before the merge; nothing else is written.",
  })
  if (gate.kind === "refuse") {
    console.error(gate.message)
    process.exit(1)
  }
  if (gate.note) console.log(gate.note)

  const db = makeMaintenancePostgres(connectionString(), 1)
  try {
    // The unscoped listing reads every source cell; the write must not queue
    // behind a projection rebuild's row locks for long.
    await db.exec(`SET statement_timeout = '600s'`)
    await db.exec(`SET lock_timeout = '5s'`)

    const found = await listDamagedCellMetadata(db, { projectId: onlyProject })
    const reports: FileReport[] = []
    for (const file of found) {
      if (!apply) {
        reports.push({ ...file, restored: null, leftAlone: file.damaged - file.restorable })
        continue
      }
      const restored = file.restorable > 0
        ? await restoreDamagedCellMetadata(db, file.projectId, file.fileId)
        : 0
      reports.push({ ...file, restored, leftAlone: file.damaged - restored })
    }

    const damaged = reports.reduce((sum, r) => sum + r.damaged, 0)
    const restorable = reports.reduce((sum, r) => sum + r.restorable, 0)
    const restored = reports.reduce((sum, r) => sum + (r.restored ?? 0), 0)
    const leftAlone = reports.reduce((sum, r) => sum + r.leftAlone, 0)
    const scope = onlyProject ? `project ${onlyProject}` : "every project"

    console.log(
      apply
        ? `APPLY (${scope}): ${restored} of ${damaged} damaged cell(s) put back in ${reports.length} file(s).`
        : `DRY RUN (${scope}): ${damaged} damaged cell(s) in ${reports.length} file(s); ${restorable} can be put back.`,
    )
    for (const report of reports) console.log(fileLine(report))
    if (leftAlone > 0) {
      console.log(
        `${leftAlone} cell(s) hold an array this repair does not touch. Look at them by hand:\n` +
          `  SELECT cell_id, metadata FROM cells WHERE project_id = '<id>' AND side = 'source' AND jsonb_typeof(metadata) = 'array'`,
      )
    }
    if (!apply && restorable > 0) {
      console.log(
        `nothing was written. Re-run with --apply${process.env.AQUILLA_NEON_TARGET === "production" ? ` ${PRODUCTION_FLAG}` : ""}` +
          `${onlyProject ? ` --only ${onlyProject}` : " --only <projectId>"} once this report is read.`,
      )
    }

    if (outPath) {
      writeFileSync(
        outPath,
        JSON.stringify({ mode: apply ? "apply" : "dry-run", scope, damaged, restorable, restored, leftAlone, files: reports }, null, 2) + "\n",
      )
      console.log(`wrote ${outPath}`)
    }

    // A listing said these could be put back and the write did not take them:
    // something changed underneath, and the operator should know before leaving.
    if (apply && restored !== restorable) {
      console.error(`✗ expected to put back ${restorable} cell(s), wrote ${restored}. Run the dry run again.`)
      process.exitCode = 1
    }
  } finally {
    await db.close?.()
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(message)
  process.exit(1)
})
