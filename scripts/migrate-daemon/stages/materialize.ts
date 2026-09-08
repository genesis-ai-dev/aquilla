// Stage 3: turn a fetched working copy into an on-disk NDJSON plan.
//
// Fidelity contract: the events emitted here must be byte-identical to what
// `scripts/migrate-all.ts` produces for the same checkout — only the scheduling
// and the memory shape change. migrate-all builds every pair's events in one
// array and delta-filters against a project-wide fetch of existing ids; we walk
// one file at a time, delta-filter against the local ledger, and stream each
// line straight to disk so a 5k-file project never materializes in RAM.
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { parseCodexNotebook } from "../../../src/lib/codex-editor/parse-codex"
import type { CodexNotebookFile } from "../../../src/lib/codex-editor/types"
import { mapFilePairToEvents, collectSpeakers, type FilePairInput } from "../../../src/lib/migrate/map"
import { mapComments } from "../../../src/lib/migrate/comments"
import { fileIdFor } from "../../../src/lib/migrate/ids"
import { assessIdmlPair, isIdmlPair } from "../../../src/lib/migrate/idml"
import type { IngestEvent } from "../../../src/lib/migrate/types"
import {
  resolveGitlabIdmlOriginal,
  downloadGitlabIdmlOriginalBytes,
  type GitlabIdmlOriginal,
} from "../../lib/idml-migration-artifacts"
import { computeOrphanRetractions } from "../../lib/migrate-orphans"
import { castLikeSpeakers } from "../../../src/lib/import/cast-from-speakers"
import type { DaemonDb, JobRow, ProjectRow } from "../db"
import { PlanWriter, eventHash, type PlanLine } from "../plan"

/** MUST equal `CONTENT_LOGIC_VERSION` in scripts/migrate-all.ts — a project is
 *  only skippable while the mapping logic that produced its events is the same
 *  one running now. See the parity test in __tests__/materialize.test.ts. */
export const CONTENT_LOGIC_VERSION = 4
const FALLBACK_AUTHOR = "legacy-import"
const COMMENTS_PATH = ".project/comments.json"

export interface MaterializeDeps {
  db: DaemonDb
  syncBase: string
  syncSecret: string
  plansDir: string
  gitlabToken: string
  now?: () => number
}
export interface MaterializeInput {
  job: JobRow
  project: ProjectRow
  dir: string
  httpUrlToRepo: string
  force?: boolean
}
export interface MaterializeResult {
  planPath: string
  lines: number
  files: number
  changedFiles: number
  castHash: string
  speakers: { cellId: string; speaker: string }[]
  fileHashes: { path: string; hash: string }[]
  idml: Array<{ relPath: string; fileId: string; original: GitlabIdmlOriginal | undefined }>
}

/** `ReadonlySet` view of the project's applied-events ledger. The orphan pass
 *  only ever calls `.has()` (per candidate id) and `.size` (its early-out), so
 *  nothing is ever materialized; iteration would be a full table scan and is
 *  deliberately unsupported. */
class LedgerSet implements ReadonlySet<string> {
  private readonly db: DaemonDb
  private readonly projectId: number
  readonly size: number
  constructor(db: DaemonDb, projectId: number, size: number) {
    this.db = db
    this.projectId = projectId
    this.size = size
  }
  has(id: string): boolean { return this.db.ledgerHas(this.projectId, id) }
  forEach(): never { throw new Error("LedgerSet: iteration is not supported") }
  keys(): never { throw new Error("LedgerSet: iteration is not supported") }
  values(): never { throw new Error("LedgerSet: iteration is not supported") }
  entries(): never { throw new Error("LedgerSet: iteration is not supported") }
  [Symbol.iterator](): never { throw new Error("LedgerSet: iteration is not supported") }
}

function listByStem(dir: string, ext: string): Map<string, string> {
  const m = new Map<string, string>()
  if (!fs.existsSync(dir)) return m
  for (const f of fs.readdirSync(dir)) if (f.endsWith(ext)) m.set(f.slice(0, -ext.length), path.join(dir, f))
  return m
}
function parseNb(raw: string | undefined): CodexNotebookFile | undefined {
  if (raw === undefined) return undefined
  try { return parseCodexNotebook(raw) } catch { return undefined }
}
const readOrEmpty = (file: string | undefined): string =>
  file !== undefined && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Keep only the plan we are about to write: a project accumulates one plan
 *  per sha otherwise, and a 17M-event corpus makes that unbounded on disk.
 *  Best-effort — a plan another process still holds open is not our business. */
function prunePlans(dir: string, keep: string): void {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".ndjson")) continue
    const full = path.join(dir, f)
    if (full === keep) continue
    try { fs.rmSync(full) } catch { /* best-effort */ }
  }
}

export async function materialize(deps: MaterializeDeps, input: MaterializeInput): Promise<MaterializeResult> {
  const { db } = deps
  const { job, project, dir, force } = input
  const now = deps.now ?? Date.now
  const projectId = project.aquilla_id
  const projectKey = String(project.gitlab_id)

  const targets = listByStem(path.join(dir, "files/target"), ".codex")
  const sources = listByStem(path.join(dir, ".project/sourceTexts"), ".source")
  const stems = [...new Set([...targets.keys(), ...sources.keys()])].sort()

  // Spec layout: plans/<gitlabId>/<sha>.ndjson — the parity gate picks the
  // newest file per project id, so one directory per project is required.
  const projectPlansDir = path.join(deps.plansDir, projectKey)
  const planPath = path.join(projectPlansDir, `${job.sha}.ndjson`)
  const writer = new PlanWriter(planPath)
  prunePlans(projectPlansDir, planPath)
  const ledgerSize = db.ledgerCount(project.gitlab_id)
  const existingEventIds = new LedgerSet(db, project.gitlab_id, ledgerSize)

  const speakers: { cellId: string; speaker: string }[] = []
  const fileHashes: { path: string; hash: string }[] = []
  const idml: MaterializeResult["idml"] = []
  let files = 0
  let changedFiles = 0

  const emit = async (events: IngestEvent[], prerequisiteIds: ReadonlySet<string>): Promise<void> => {
    const fresh = new Set(db.ledgerFilterNew(project.gitlab_id, events.map((e) => e.id)))
    for (const event of events) {
      if (!fresh.has(event.id)) continue
      const line: PlanLine = { id: event.id, event, hash: eventHash(event) }
      if (prerequisiteIds.has(event.id)) line.prerequisite = true
      await writer.write(line)
    }
  }

  try {
    for (const stem of stems) {
      const sourceRaw = readOrEmpty(sources.get(stem))
      const targetRaw = readOrEmpty(targets.get(stem))
      const hash = sha256(`${sourceRaw}\0${targetRaw}`)
      fileHashes.push({ path: stem, hash })

      const source = parseNb(sources.get(stem) ? sourceRaw : undefined)
      const target = parseNb(targets.get(stem) ? targetRaw : undefined)
      if (!source && !target) continue
      files++
      const pair: FilePairInput = { relPath: stem, name: stem, source, target }

      // The cast is a whole-project judgement (AQU-813): a name only counts as a
      // speaker relative to every other label in the project. So unchanged pairs
      // are still parsed for `collectSpeakers` — but nothing else — and dropped
      // immediately, which keeps peak memory at one file rather than all of them.
      speakers.push(...collectSpeakers(pair))

      const unchanged = !force
        && project.applied_sha !== null
        && project.content_logic === CONTENT_LOGIC_VERSION
        && db.fileHash(project.gitlab_id, stem) === hash
      if (unchanged) continue
      changedFiles++

      const original = isIdmlPair(pair) ? resolveGitlabIdmlOriginal(dir, pair) : undefined
      const originalBytes = original
        ? await downloadGitlabIdmlOriginalBytes({
          original,
          repositoryUrl: input.httpUrlToRepo,
          gitlabToken: deps.gitlabToken,
        })
        : undefined
      const assessment = isIdmlPair(pair) ? await assessIdmlPair(pair, originalBytes) : undefined
      const fileId = fileIdFor(projectKey, stem)
      if (assessment) idml.push({ relPath: stem, fileId, original })

      const events = mapFilePairToEvents(pair, {
        projectId,
        projectKey,
        fallbackAuthor: FALLBACK_AUTHOR,
        fallbackTs: now(),
        ...(assessment ? { idmlAssessment: assessment } : {}),
      })
      // The orphan pass is per-file by construction: it iterates the fileIds it
      // finds in `events` and reconciles each against that file's projection
      // rows, with no state carried between files — so calling it once per pair
      // yields exactly what migrate-all's single project-wide call does.
      if (ledgerSize > 0) {
        const { retractions, repairs, resurrections } = await computeOrphanRetractions({
          syncBase: deps.syncBase,
          secret: deps.syncSecret,
          projectId,
          events,
          existingEventIds,
          fallbackAuthor: FALLBACK_AUTHOR,
          fallbackTs: now(),
        })
        events.push(...retractions, ...resurrections, ...repairs)
      }
      const prerequisiteIds = new Set(
        original
          ? events.filter((e) => e.kind === "file.create" && e.fileId === fileId).map((e) => e.id)
          : [],
      )
      await emit(events, prerequisiteIds)
    }

    const commentsFile = path.join(dir, COMMENTS_PATH)
    if (fs.existsSync(commentsFile)) {
      const raw = fs.readFileSync(commentsFile, "utf8")
      const hash = sha256(raw)
      fileHashes.push({ path: COMMENTS_PATH, hash })
      const commentsUnchanged = !force
        && project.applied_sha !== null
        && project.content_logic === CONTENT_LOGIC_VERSION
        && db.fileHash(project.gitlab_id, COMMENTS_PATH) === hash
      if (!commentsUnchanged) {
        try {
          const parsed: unknown = JSON.parse(raw)
          await emit(mapComments(parsed, { projectId, projectKey, fallbackTs: now() }), new Set())
        } catch { /* skip bad comments, exactly as migrate-all does */ }
      }
    }
  } finally {
    await writer.close()
  }

  const cast = castLikeSpeakers(speakers).sort((a, b) => a.cellId.localeCompare(b.cellId))
  return {
    planPath,
    lines: writer.lines,
    files,
    changedFiles,
    castHash: sha256(JSON.stringify(cast)),
    speakers,
    fileHashes,
    idml,
  }
}
