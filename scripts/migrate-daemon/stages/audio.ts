// Audio stage for the Codex → Aquilla daemon. The checkout contains only LFS
// pointer text; bytes are copied directly between the source and destination
// R2 buckets, then deterministic audio events are ingested.
import fs from "node:fs"
import path from "node:path"
import { parseCodexNotebook } from "../../../src/lib/codex-editor/parse-codex"
import type { CodexNotebookFile } from "../../../src/lib/codex-editor/types"
import { fileIdFor } from "../../../src/lib/migrate/ids"
import { audioDestKey, gitlabLfsKey } from "../../../src/lib/migrate/r2-s3"
import { buildCellAudioEvents, buildOidIndex, planCellAudio } from "../../../src/lib/migrate/audio-copy"
import { discoverPointers } from "../../../src/lib/migrate/gitlab/lfs"
import type { AudioImport } from "../../../src/lib/migrate/audio"
import type { ProjectRow } from "../db"
import type { SyncClient } from "../http"

export const LFS_BUCKET = "codex-attachments-v1-1"
export const AUDIO_BUCKET = "aquilla-snapshots"

export interface AudioDeps {
  copyObject: (sourceBucket: string, sourceKey: string, targetBucket: string, targetKey: string) => Promise<void>
  sync: Pick<SyncClient, "ingest">
  copyConcurrency: number
  dryRun: boolean
  onProgress?: (progress: { copied: number; total: number; missing: number; failed: number }) => void
}

export interface AudioResult {
  total: number
  copied: number
  missingOid: number
  lfsMiss: number
  failed: number
  events: number
}

interface CopyUnit {
  projectId: string
  cellId: string
  fileId: string
  take: AudioImport
  oid: string
}

interface CellPlan {
  cellId: string
  fileId: string
  selected: string | null
}

function readNotebook(file: string): CodexNotebookFile | undefined {
  try {
    return parseCodexNotebook(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

async function copyWithRetry(deps: AudioDeps, unit: CopyUnit): Promise<"copied" | "missing" | "failed"> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await deps.copyObject(LFS_BUCKET, gitlabLfsKey(unit.oid), AUDIO_BUCKET,
        audioDestKey(unit.projectId, unit.fileId, unit.take.aquillaAudioId))
      return "copied"
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 404) return "missing"
      if (attempt === 3) return "failed"
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
    }
  }
  return "failed"
}

export async function migrateProjectAudio(
  deps: AudioDeps,
  input: { project: ProjectRow; dir: string },
): Promise<AudioResult> {
  const { project, dir } = input
  const projectId = project.aquilla_id
  const oidIndex = buildOidIndex(discoverPointers(dir).pointers)
  const units: CopyUnit[] = []
  const cells: CellPlan[] = []
  let missingOid = 0
  const targetDir = path.join(dir, "files/target")

  if (fs.existsSync(targetDir)) {
    for (const name of fs.readdirSync(targetDir)) {
      if (!name.endsWith(".codex")) continue
      const target = readNotebook(path.join(targetDir, name))
      if (!target) continue
      const relPath = name.slice(0, -".codex".length)
      const fileId = fileIdFor(String(project.gitlab_id), relPath)
      for (const cell of target.cells) {
        const plan = planCellAudio(cell, oidIndex)
        missingOid += plan.missingOid.length
        if (plan.copies.length === 0) continue
        cells.push({ cellId: cell.metadata.id, fileId, selected: plan.selectedAquillaAudioId })
        for (const copy of plan.copies) {
          units.push({
            projectId,
            cellId: cell.metadata.id,
            fileId,
            take: copy.take,
            oid: copy.oid,
          })
        }
      }
    }
  }

  const result: AudioResult = {
    total: units.length,
    copied: 0,
    missingOid,
    lfsMiss: 0,
    failed: 0,
    events: 0,
  }
  if (deps.dryRun) return result
  if (units.length === 0) {
    if (missingOid > 0) throw new Error(`audio copy incomplete: ${missingOid} attachments have no LFS object id`)
    return result
  }

  const landedByCell = new Map<string, AudioImport[]>()
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, deps.copyConcurrency), units.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= units.length) return
      const unit = units[index]
      const outcome = await copyWithRetry(deps, unit)
      if (outcome === "copied") {
        result.copied++
        const landed = landedByCell.get(unit.cellId) ?? []
        landed.push(unit.take)
        landedByCell.set(unit.cellId, landed)
      } else if (outcome === "missing") {
        result.lfsMiss++
      } else {
        result.failed++
      }
      deps.onProgress?.({ copied: result.copied, total: result.total, missing: result.lfsMiss, failed: result.failed })
    }
  })
  await Promise.all(workers)

  const fallbackTs = Date.now()
  const events = cells.flatMap((cell) => {
    const landed = landedByCell.get(cell.cellId) ?? []
    return landed.length === 0 ? [] : buildCellAudioEvents(cell.cellId, landed, cell.selected, {
      projectId,
      fileId: cell.fileId,
      fallbackAuthor: "legacy-import",
      fallbackTs,
    })
  })
  for (let offset = 0; offset < events.length; offset += 300) {
    await deps.sync.ingest(projectId, events.slice(offset, offset + 300))
  }
  result.events = events.length
  if (result.lfsMiss > 0 || result.failed > 0) {
    throw new Error(`audio copy incomplete: ${result.lfsMiss} LFS objects missing, ${result.failed} copy failures`)
  }
  return result
}
