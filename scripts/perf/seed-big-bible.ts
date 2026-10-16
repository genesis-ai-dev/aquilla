#!/usr/bin/env tsx
/**
 * AQU-1868 — seed the "Big Bible" performance fixture.
 *
 *   pnpm dev                      # the stack this seeds into
 *   pnpm perf:seed                # 66 files, 31,102 cells, 2 target lanes
 *   pnpm perf:seed --books 2 --cells 500   # fast smoke of the seeder itself
 *
 * Writes `.perf/big-bible.json` (the fixture handle) so `pnpm perf:measure`
 * and `pnpm perf:presence` measure THIS project rather than re-seeding or
 * being pointed at one by hand.
 *
 * Everything goes through the product's own write paths — `POST /import` for
 * the bulk source + bilingual genesis commits, `POST /events` for the history
 * depth and the audio attachments — so the fixture is a project the app could
 * have produced, not rows conjured straight into Postgres.
 *
 * Flags
 *   --cells N        total cells across every book (default 31,102)
 *   --books N        only the first N books (default 66)
 *   --lanes N        target lanes, 1 or 2 (default 2)
 *   --history N      extra target commits spread over the fixture (default 400)
 *   --audio N        synthetic audio takes to attach (default 0 — see README)
 *   --concurrency N  files imported in parallel (default 4)
 *   --chunk N        cells per /import request (default 1500, as the SPA)
 *   --project-id ID  reuse a project id (default: a fresh uuid)
 *   --name NAME      project name
 *   --handle PATH    where to write the fixture handle
 *   --auth-base URL  auth-worker origin (default http://127.0.0.1:8788)
 *   --sync-base URL  sync-worker origin (default http://127.0.0.1:8789)
 */

import { parseArgs } from "node:util"
import { randomUUID } from "node:crypto"
import { v7 as uuidv7 } from "uuid"
import {
  bulkImport,
  createLane,
  createProject,
  devLogin,
  mintSyncToken,
  patchLane,
  postEvents,
  readLanes,
  DEFAULT_TARGET,
  type ImportCellInput,
  type ImportTargetInput,
  type PerfTarget,
  type RawEventInput,
} from "./lib/client"
import { planBigBible, type PlannedFile } from "./lib/big-bible-plan"
import {
  DEFAULT_HANDLE_PATH,
  writeHandle,
  type BigBibleHandle,
  type SeededFileHandle,
} from "./lib/fixture-handle"

/** Matches `src/lib/sync/bulk-import.ts` CHUNK, so a chunk costs what it costs in production. */
const DEFAULT_CHUNK = 1500
/** `src/lib/sync/outbox-types.ts` OUTBOX_SCHEMA_VERSION. */
const SCHEMA_VERSION = 1
/** Commit-chain anchors kept per file for the measurement run. */
const COMMIT_TARGETS_PER_FILE = 4

interface SeedOptions {
  cells: number
  books: number
  lanes: number
  history: number
  audio: number
  concurrency: number
  chunk: number
  projectId: string
  name: string
  handle: string
  target: PerfTarget
}

function parseSeedOptions(argv: string[]): SeedOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      cells: { type: "string" },
      books: { type: "string" },
      lanes: { type: "string" },
      history: { type: "string" },
      audio: { type: "string" },
      concurrency: { type: "string" },
      chunk: { type: "string" },
      "project-id": { type: "string" },
      name: { type: "string" },
      handle: { type: "string" },
      "auth-base": { type: "string" },
      "sync-base": { type: "string" },
    },
    allowPositionals: false,
  })
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`expected a number, got ${raw}`)
    return Math.floor(parsed)
  }
  const lanes = num(values.lanes, 2)
  if (lanes < 1 || lanes > 2) throw new Error("--lanes must be 1 or 2")
  return {
    cells: num(values.cells, 31_102),
    books: num(values.books, 66),
    lanes,
    history: num(values.history, 400),
    audio: num(values.audio, 0),
    concurrency: Math.max(1, num(values.concurrency, 4)),
    chunk: Math.max(1, num(values.chunk, DEFAULT_CHUNK)),
    projectId: values["project-id"] ?? randomUUID(),
    name: values.name ?? `Big Bible perf ${new Date().toISOString().slice(0, 10)}`,
    handle: values.handle ?? DEFAULT_HANDLE_PATH,
    target: {
      authBase: values["auth-base"] ?? DEFAULT_TARGET.authBase,
      syncBase: values["sync-base"] ?? DEFAULT_TARGET.syncBase,
    },
  }
}

/**
 * Lanes, as Settings → Languages creates them: the project's own source lane
 * gets a language, then one or two target lanes. The FIRST target lane's
 * legacy_tag is its language (AQU-538), which is what `targetLang` on an
 * import target names.
 */
async function ensureLanes(
  target: PerfTarget,
  jwt: string,
  projectId: string,
  laneCount: number,
): Promise<{ lanes: BigBibleHandle["lanes"]; tags: string[] }> {
  const existing = await readLanes(target, jwt, projectId)
  const source = existing.find((lane) => lane.role === "source")
  if (source && (typeof source.language !== "string" || source.language.trim() === "")) {
    await patchLane(target, jwt, projectId, source.id, { language: "English", code: "en" })
  }
  const tags: string[] = []
  const wanted: Array<{ language: string; code: string }> = [
    { language: "Spanish", code: "es" },
    { language: "French", code: "fr" },
  ].slice(0, laneCount)
  for (const lane of wanted) {
    const created = await createLane(target, jwt, projectId, { name: "", language: lane.language, code: lane.code })
    tags.push(created.legacyTag ?? lane.language)
  }
  const lanes = await readLanes(target, jwt, projectId)
  return {
    lanes: lanes.map((lane) => ({
      id: lane.id,
      role: lane.role,
      legacyTag: lane.legacyTag,
      language: lane.language ?? null,
    })),
    tags,
  }
}

/** Import one book as its own file, in production-sized chunks. */
async function seedFile(
  target: PerfTarget,
  jwt: string,
  projectId: string,
  file: PlannedFile,
  options: SeedOptions,
  laneTags: string[],
): Promise<SeededFileHandle> {
  const fileId = randomUUID()
  const token = await mintSyncToken(target, jwt, projectId, fileId)
  const commitTargets: SeededFileHandle["commitTargets"] = []
  let anchorCellId: string | null = null

  for (let offset = 0; offset === 0 || offset < file.cells.length; offset += options.chunk) {
    const planned = file.cells.slice(offset, offset + options.chunk)
    const cells: ImportCellInput[] = []
    const targets: ImportTargetInput[] = []
    planned.forEach((cell, index) => {
      const sourceEventId = uuidv7()
      cells.push({
        id: sourceEventId,
        cellId: cell.cellId,
        anchorCellId,
        value: cell.text,
        ...(cell.type === null ? {} : { type: cell.type }),
        ...(cell.canonicalRef === null ? {} : { canonicalRef: cell.canonicalRef }),
        sequenceIndex: offset + index,
      })
      anchorCellId = cell.cellId
      if (cell.targetText !== null && laneTags[0]) {
        const targetEventId = uuidv7()
        targets.push({
          id: targetEventId,
          cellId: cell.cellId,
          parentId: sourceEventId,
          value: cell.targetText,
          targetLang: laneTags[0],
        })
        if (commitTargets.length < COMMIT_TARGETS_PER_FILE) {
          commitTargets.push({ cellId: cell.cellId, parentEventId: targetEventId })
        }
      }
      if (cell.secondLaneText !== null && laneTags[1]) {
        targets.push({
          id: uuidv7(),
          cellId: cell.cellId,
          parentId: sourceEventId,
          value: cell.secondLaneText,
          targetLang: laneTags[1],
        })
      }
    })
    await bulkImport(target, token, {
      projectId,
      fileId,
      cells,
      ...(targets.length > 0 ? { targets } : {}),
      clientTs: Date.now(),
      ...(offset === 0
        ? {
            file: {
              id: uuidv7(),
              role: "source",
              name: file.name,
              fileType: "usfm",
              kind: "usfm",
              importFormat: "usfm",
              parserVersion: "perf-big-bible-v1",
            },
          }
        : {}),
    })
  }
  await bulkImport(target, token, { projectId, fileId, cells: [], complete: true })
  return { id: fileId, name: file.name, bookCode: file.bookCode, cells: file.cells.length, commitTargets }
}

/** Run `tasks` with at most `limit` in flight, preserving result order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        results[index] = await run(items[index], index)
      }
    }),
  )
  return results
}

/**
 * Give the fixture history depth: each commit chains on the previous winning
 * target event for its cell, so `useCellHistory` and the parent-chain guard
 * have something real to walk. A fixture whose every cell has exactly one
 * event hides every cost that scales with chain length.
 */
async function seedHistory(
  target: PerfTarget,
  jwt: string,
  projectId: string,
  username: string,
  files: SeededFileHandle[],
  laneTag: string | undefined,
  commits: number,
): Promise<number> {
  const anchors = files.flatMap((file) =>
    file.commitTargets.map((anchor, index) => ({ file, anchor, index })),
  )
  if (commits === 0 || anchors.length === 0 || !laneTag) return 0
  let written = 0
  const perAnchor = Math.max(1, Math.ceil(commits / anchors.length))
  for (const { file, anchor } of anchors) {
    if (written >= commits) break
    const token = await mintSyncToken(target, jwt, projectId, file.id)
    let parentId = anchor.parentEventId
    for (let revision = 1; revision <= perAnchor && written < commits; revision++) {
      const event: RawEventInput = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        kind: "target.cell.commit",
        projectId,
        fileId: file.id,
        cellId: anchor.cellId,
        parentId,
        author: username,
        payload: { value: `Perf revision ${revision} of ${anchor.cellId}`, targetLang: laneTag },
        clientTs: Date.now(),
      }
      await postEvents(target, token, [event])
      parentId = event.id
      written++
    }
    // The handle must point at the CURRENT head, or a measured commit chains
    // on a stale parent and is logged as a stale sibling instead of applying.
    anchor.parentEventId = parentId
  }
  return written
}

/**
 * Attach synthetic audio takes so the audio progress columns are non-empty.
 * Default OFF: the clips are not real R2 objects, so they populate projection
 * rows but will not play. See scripts/perf/README.md.
 */
async function seedAudio(
  target: PerfTarget,
  jwt: string,
  projectId: string,
  username: string,
  files: SeededFileHandle[],
  laneTag: string | undefined,
  takes: number,
): Promise<number> {
  if (takes === 0 || !laneTag) return 0
  let written = 0
  for (const file of files) {
    if (written >= takes) break
    const token = await mintSyncToken(target, jwt, projectId, file.id)
    for (const anchor of file.commitTargets) {
      if (written >= takes) break
      const audioId = randomUUID()
      const attach: RawEventInput = {
        id: uuidv7(),
        schemaVersion: SCHEMA_VERSION,
        kind: "cell.audio.attach",
        projectId,
        fileId: file.id,
        cellId: anchor.cellId,
        parentId: null,
        author: username,
        payload: {
          audioId,
          url: `frontier-audio://perf/${audioId}.webm`,
          slot: "recording",
          mimeType: "audio/webm",
          durationMs: 3_200,
          label: "Perf take",
          targetLang: laneTag,
        },
        clientTs: Date.now(),
      }
      const select: RawEventInput = {
        ...attach,
        id: uuidv7(),
        kind: "cell.audio.select",
        payload: { audioId, slot: "recording", targetLang: laneTag },
      }
      await postEvents(target, token, [attach, select])
      written++
    }
  }
  return written
}

async function main(): Promise<void> {
  const options = parseSeedOptions(process.argv.slice(2))
  const plan = planBigBible({ targetCells: options.cells, books: options.books })
  console.log(
    `[perf] seeding ${plan.stats.files} files / ${plan.stats.cells.toLocaleString()} cells ` +
      `(${plan.stats.verses.toLocaleString()} verses, ${plan.stats.translated.toLocaleString()} translated) ` +
      `into ${options.target.syncBase}`,
  )

  const session = await devLogin(options.target)
  const project = await createProject(options.target, session.jwt, {
    id: options.projectId,
    name: options.name,
  })
  const { lanes, tags } = await ensureLanes(options.target, session.jwt, project.id, options.lanes)
  console.log(`[perf] project ${project.id} — lanes ${tags.join(", ") || "(none)"}`)

  const startedAt = Date.now()
  let done = 0
  const files = await mapWithLimit(plan.files, options.concurrency, async (file) => {
    const seeded = await seedFile(options.target, session.jwt, project.id, file, options, tags)
    done++
    if (done % 5 === 0 || done === plan.files.length) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
      console.log(`[perf] imported ${done}/${plan.files.length} files (${elapsed}s)`)
    }
    return seeded
  })

  const historyCommits = await seedHistory(
    options.target,
    session.jwt,
    project.id,
    session.username,
    files,
    tags[0],
    options.history,
  )
  const audioAttachments = await seedAudio(
    options.target,
    session.jwt,
    project.id,
    session.username,
    files,
    tags[0],
    options.audio,
  )

  const handle: BigBibleHandle = {
    harness: "big-bible",
    seededAt: new Date().toISOString(),
    target: options.target,
    username: session.username,
    projectId: project.id,
    projectName: project.name,
    lanes,
    files,
    stats: { ...plan.stats, historyCommits, audioAttachments },
  }
  writeHandle(options.handle, handle)

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `[perf] seeded in ${seconds}s — ${files.length} files, ${plan.stats.cells.toLocaleString()} cells, ` +
      `${historyCommits} history commits, ${audioAttachments} audio takes`,
  )
  console.log(`[perf] handle written to ${options.handle} — run \`pnpm perf:measure\` next`)
}

main().catch((error: unknown) => {
  console.error(`[perf] seed failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
