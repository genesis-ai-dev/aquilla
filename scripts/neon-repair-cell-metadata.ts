#!/usr/bin/env tsx
// AQU-2658 — put back the source cells a metadata merge damaged. Dry-run by default.
//
// Until AQU-2658 a metadata patch merged into a link-mirrored cell's envelope
// (stored as a JSON string) built the array `["<envelope json>", {}]`, and the
// cell lost its IDML locator: the file's InDesign export stopped on "has no
// supported IDML v2 locator". "Place translations" did it to every validated
// line it placed. The projection no longer does; this repairs the rows it left.
//
// To a cell it writes one thing: `metadata = metadata -> 0`, the value the row
// held before the merge, and only where the rest of the array is nothing but
// empty patches. Any other array is reported and left alone. It never deletes.
//
// Then it moves the project's rebuild marker, in the same transaction. Without
// that the repair is invisible: every browser keeps the file's cells in
// IndexedDB and asks only for what changed since, and a row put back mints no
// event. With it, each client reads the project again in full the next time it
// opens a file. A second apply finds nothing to put back and writes nothing.
//
// --resync moves the marker for a project whose cells are already right — one
// repaired before this command did that itself. It needs --only.
//
//   pnpm neon:repair-cell-metadata:dev
//   pnpm neon:repair-cell-metadata:prod -- --only <projectId>
//   pnpm neon:repair-cell-metadata:prod -- --only <projectId> --out /tmp/cell-metadata-prod.json
//   pnpm neon:repair-cell-metadata:prod -- --apply --production --only <projectId>
//   pnpm neon:repair-cell-metadata:prod -- --apply --production --only <projectId> --resync
//
// Without --only the dry run reads every source cell in the database: a few
// minutes on production. Do not pass --apply until a person has read the
// dry-run report. See db/shared/cell-metadata-repair.ts.
//
// Flags: --apply  --production  --only <projectId>  --resync  --out <file>
import { writeFileSync } from "node:fs"
import {
  listDamagedCellMetadata,
  repairProjectCellMetadata,
  type DamagedCellMetadataFile,
} from "../db/shared/cell-metadata-repair"
import { makeMaintenancePostgres } from "../db/shim/postgres"
import { decidePruneGate, PRODUCTION_FLAG } from "./phantom-voice-prune"

const APPLY_COMMAND = "pnpm neon:repair-cell-metadata"
const RESYNC_FLAG = "--resync"

interface FileReport extends DamagedCellMetadataFile {
  /** Cells this run wrote. Null on a dry run. */
  restored: number | null
  /** Arrays still there afterwards (a dry run: the ones it would leave). */
  leftAlone: number
}

interface ProjectReport {
  projectId: string
  /** The rebuild marker this run set. Null: a dry run, or nothing to announce. */
  resyncMarker: number | null
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
  const resync = process.argv.includes(RESYNC_FLAG)
  const onlyProject = flagValue("--only")
  const outPath = flagValue("--out")
  if (resync && !onlyProject) {
    throw new Error(
      `${RESYNC_FLAG} needs --only <projectId>: it makes every client of that one project read it again in full.`,
    )
  }

  const gate = decidePruneGate({
    apply,
    production,
    target: process.env.AQUILLA_NEON_TARGET?.trim() || undefined,
    localUrl: process.env.AQUILLA_LOCAL_PG_URL?.trim() || undefined,
    applyCommand: APPLY_COMMAND,
    action: "restore cell metadata",
    productionNote: "Each cell is put back to the value it held before the merge, and the project's rebuild marker moves so clients read it again; nothing else is written.",
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
    const projects: ProjectReport[] = []
    // Every project with something to put back, and the one named with
    // --resync even when it has nothing left to.
    const projectIds = [...new Set(found.map((file) => file.projectId))]
    if (resync && onlyProject && !projectIds.includes(onlyProject)) projectIds.push(onlyProject)

    for (const projectId of projectIds) {
      const files = found.filter((file) => file.projectId === projectId)
      if (!apply) {
        for (const file of files) reports.push({ ...file, restored: null, leftAlone: file.damaged - file.restorable })
        projects.push({ projectId, resyncMarker: null })
        continue
      }
      const repaired = await repairProjectCellMetadata(
        db,
        projectId,
        files.filter((file) => file.restorable > 0).map((file) => file.fileId),
        { resync },
      )
      for (const file of files) {
        const restored = repaired.restoredByFile[file.fileId] ?? 0
        reports.push({ ...file, restored, leftAlone: file.damaged - restored })
      }
      projects.push({ projectId, resyncMarker: repaired.resyncMarker })
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
    for (const project of projects) {
      if (project.resyncMarker !== null) {
        console.log(
          `  project ${project.projectId}: clients will read it again in full the next time they open a file (rebuild marker ${project.resyncMarker}).`,
        )
      } else if (!apply && resync && project.projectId === onlyProject) {
        console.log(`  project ${project.projectId}: ${RESYNC_FLAG} would make its clients read it again in full.`)
      }
    }
    if (leftAlone > 0) {
      console.log(
        `${leftAlone} cell(s) hold an array this repair does not touch. Look at them by hand:\n` +
          `  SELECT cell_id, metadata FROM cells WHERE project_id = '<id>' AND side = 'source' AND jsonb_typeof(metadata) = 'array'`,
      )
    }
    if (!apply && (restorable > 0 || resync)) {
      console.log(
        `nothing was written. Re-run with --apply${process.env.AQUILLA_NEON_TARGET === "production" ? ` ${PRODUCTION_FLAG}` : ""}` +
          `${onlyProject ? ` --only ${onlyProject}` : " --only <projectId>"}${resync ? ` ${RESYNC_FLAG}` : ""} once this report is read.`,
      )
    }
    if (apply && onlyProject && restored === 0 && !resync) {
      console.log(
        `nothing to put back. If this project's cells were repaired before this command moved the rebuild marker,\n` +
          `browsers that had its files open still show the old cells: add ${RESYNC_FLAG} to make them read it again.`,
      )
    }

    if (outPath) {
      writeFileSync(
        outPath,
        JSON.stringify({ mode: apply ? "apply" : "dry-run", scope, damaged, restorable, restored, leftAlone, files: reports, projects }, null, 2) + "\n",
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
