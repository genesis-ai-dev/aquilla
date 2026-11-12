// AQU-2125 — everything `scripts/neon-fold-cast-by-character.ts` does except
// the I/O: which projects are worth loading, which lines name a character, and
// what folding one project's cast would do. Kept out of the runner so it can be
// tested — the SQL against PGlite, the fold itself in
// `src/lib/audio/character-cast.ts`.
//
// WHY A SCRIPT AT ALL. The app folds a project's cast as people work on it, but
// only over the file that is open: a save cannot see the other episodes' lines.
// A project already over the settings cap is a project nobody can finish
// folding that way, so this folds every line of it at once, from the database,
// where every line's character (`cells.metadata.cast_name`) is known.
//
// The write gate and the backup naming are the phantom-voice prune's
// (AQU-1941) — the same blind spot about which Neon branch the credentials
// point at, the same answer.
//
// NAMING LINES (`--name-lines`, opt-in). A project cast from a subtitle file's
// speaker tags, a spreadsheet's cast column or speaker detection, before those
// imports wrote the speaker onto the line, has one cast entry per line and no
// character on any of them — nothing to fold by. For such a line, the voice it
// is cast with WAS its speaker: the import minted one voice per speaker name.
// So the line is given that voice's name as its character, through the same
// `cast.assign` event a character sheet emits, and then folded like the rest.
// Only names that could be a person's are used (`castLikeSpeakers`' rules), and
// never a built-in voice or one named by its id.

import { createHash } from "node:crypto"
import { loadProjectSettings } from "../db/shared/projects"
import type { AquillaDb, AquillaStatement } from "../db/shim/postgres"
import { foldCastByCharacter, type CastLine } from "../src/lib/audio/character-cast"
import { NO_CAST_VOICE, getVoiceLibrary } from "../src/lib/audio/voices"
import { isInternalIdName } from "../src/lib/export/internal-id-names"
import { castLikeSpeakers } from "../src/lib/import/cast-from-speakers"
import type { ProjectTtsSettings } from "../src/lib/parsers/types"
import { allocateSeqRange, buildBulkEventInsertStmts, buildSettleSeqRangeStmt } from "../sync-worker/src/events/event-insert"
import { buildEventProjectionStmts } from "../sync-worker/src/events/event-projection"

export { decidePruneGate as decideFoldGate, settingsBackupPath, PRODUCTION_FLAG } from "./phantom-voice-prune"

/**
 * Below this many cast entries a project is not worth a pass: the fold would
 * save a few kilobytes on a blob nobody is waiting on. `--only` ignores it.
 */
export const DEFAULT_MIN_ENTRIES = 500

/** Projects whose project-wide cast map has at least `?` entries. */
export const CANDIDATE_SQL = `SELECT ps.project_id, p.name AS project_name,
         (SELECT count(*) FROM jsonb_object_keys(ps.settings::jsonb -> 'ttsSettings' -> 'castAssignments')) AS entries
    FROM project_settings ps
    LEFT JOIN projects p ON p.id = ps.project_id
   WHERE jsonb_typeof(ps.settings::jsonb -> 'ttsSettings' -> 'castAssignments') = 'object'`

export interface FoldCandidateRow {
  project_id: string
  project_name: string | null
  entries: number
}

/** The candidate projects, largest cast first so a `--limit` run does the worst ones. */
export async function listFoldCandidates(
  db: AquillaDb,
  opts: { onlyProject?: string; minEntries?: number; limit?: number } = {},
): Promise<FoldCandidateRow[]> {
  let sql = `SELECT * FROM (${CANDIDATE_SQL}) c`
  const binds: unknown[] = []
  if (opts.onlyProject) {
    sql += ` WHERE c.project_id = ?`
    binds.push(opts.onlyProject)
  } else {
    sql += ` WHERE c.entries >= ?`
    binds.push(opts.minEntries ?? DEFAULT_MIN_ENTRIES)
  }
  sql += ` ORDER BY c.entries DESC, c.project_id`
  if (opts.limit !== undefined) sql += ` LIMIT ${opts.limit}`
  const { results } = await db.prepare(sql).bind(...binds).all<FoldCandidateRow>()
  return results.map((r) => ({ ...r, entries: Number(r.entries) }))
}

/**
 * Every line of the project that names a character, in document order so the
 * fold's tie-break ("the first line's voice") is the same on every run. The
 * name lives on the SOURCE row, where `cast.assign` writes it.
 */
export const CAST_LINES_SQL = `SELECT cell_id, metadata ->> 'cast_name' AS cast_name
    FROM cells
   WHERE project_id = ? AND side = 'source' AND metadata ->> 'cast_name' IS NOT NULL
   ORDER BY file_id, sequence_index NULLS LAST, cell_id`

export async function loadCastLines(db: AquillaDb, projectId: string): Promise<CastLine[]> {
  const { results } = await db.prepare(CAST_LINES_SQL).bind(projectId).all<{ cell_id: string; cast_name: string | null }>()
  const lines: CastLine[] = []
  for (const row of results) {
    const castName = row.cast_name?.trim()
    if (castName) lines.push({ id: row.cell_id, castName })
  }
  return lines
}

/**
 * Every source line of the project with its character (or none), in document
 * order — what `--name-lines` reads, so the names it adds sit in the same order
 * the fold's tie-break uses.
 */
export const ALL_LINES_SQL = `SELECT cell_id, file_id, metadata ->> 'cast_name' AS cast_name,
         (tombstoned_at IS NOT NULL) AS gone
    FROM cells
   WHERE project_id = ? AND side = 'source'
   ORDER BY file_id, sequence_index NULLS LAST, cell_id`

export interface ProjectLineRow {
  cell_id: string
  file_id: string
  cast_name: string | null
  gone: boolean
}

/** A line `--name-lines` gives a character: the name of the voice it is cast with. */
export interface LineToName {
  cellId: string
  fileId: string
  castName: string
}

function ownEntry(map: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * Which lines `--name-lines` names. A line qualifies when it has no character,
 * is not deleted, and its own project-wide entry names a voice in the library
 * that is neither built in nor named by its id. The names together must still
 * look like a cast (`castLikeSpeakers`): a project whose "voices" are one per
 * line is left alone.
 */
export function planLineNames(
  tts: ProjectTtsSettings | undefined,
  rows: readonly ProjectLineRow[],
): LineToName[] {
  const map = tts?.castAssignments ?? {}
  const voices = new Map(getVoiceLibrary(tts).map((v) => [v.id, v]))
  const candidates: LineToName[] = []
  for (const row of rows) {
    if (row.gone || row.cast_name?.trim()) continue
    const voiceId = ownEntry(map, row.cell_id)
    if (voiceId === undefined || voiceId === NO_CAST_VOICE) continue
    const voice = voices.get(voiceId)
    const name = voice?.name?.trim()
    if (!voice || voice.builtIn || !name || isInternalIdName(name)) continue
    candidates.push({ cellId: row.cell_id, fileId: row.file_id, castName: name })
  }
  const kept = new Set(
    castLikeSpeakers(candidates.map((c) => ({ cellId: c.cellId, speaker: c.castName }))).map((p) => p.cellId),
  )
  return candidates.filter((c) => kept.has(c.cellId))
}

/** A stable id for "name this line", so a re-run replays as a no-op. */
export function lineNameEventId(projectId: string, cellId: string, castName: string): string {
  const hex = createHash("sha256").update(`cast-fold-name:${projectId}:${cellId}:${castName}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Events per write batch: well inside the worker's statement budget. */
export const NAME_LINES_CHUNK = 500

/**
 * Write each line's character as a `cast.assign` event, exactly as a character
 * sheet does: the canonical events row (with a server_seq, so every open copy
 * of the project picks it up on its next sync) and the projection's own update
 * of `cells.metadata.cast_name`, in one batch per chunk. Re-running replays as
 * a no-op: the event ids are derived, and the update writes the same name.
 */
export async function writeLineNames(
  db: AquillaDb,
  projectId: string,
  lines: readonly LineToName[],
  author: string,
): Promise<number> {
  let written = 0
  for (let i = 0; i < lines.length; i += NAME_LINES_CHUNK) {
    const chunk = lines.slice(i, i + NAME_LINES_CHUNK)
    const firstSeq = await allocateSeqRange(db, projectId, chunk.length)
    const now = Date.now()
    const events = chunk.map((line, j) => ({
      id: lineNameEventId(projectId, line.cellId, line.castName),
      schemaVersion: 1,
      projectId,
      fileId: line.fileId,
      cellId: line.cellId,
      parentId: null,
      kind: "cast.assign" as const,
      author,
      payload: { castName: line.castName },
      clientTs: now,
      serverTs: now,
      serverSeq: firstSeq + j,
    }))
    const stmts: AquillaStatement[] = buildBulkEventInsertStmts(
      db,
      events.map(({ payload, ...e }) => ({ ...e, payloadJson: JSON.stringify(payload) })),
    )
    for (const event of events) buildEventProjectionStmts(db, event, stmts)
    stmts.push(buildSettleSeqRangeStmt(db, projectId, firstSeq))
    await db.batch(stmts)
    written += chunk.length
  }
  return written
}

/** One line of the report, whether or not anything was written. */
export interface ProjectFoldReport {
  projectId: string
  projectName: string | null
  linesWithCharacter: number
  /** Lines `--name-lines` gives a character (the voice they are cast with). */
  linesToName: number
  entriesBefore: number
  entriesAfter: number
  characterEntries: number
  droppedLineEntries: number
  /** Lines that named a character but had no voice, and now speak with it. */
  newlyVoicedLines: number
  /** Lines held as they were with a "no voice" entry (`--keep-uncast-lines`). */
  markedLines: number
  settingsBytesBefore: number
  settingsBytesAfter: number
  versionBefore: number
  versionAfter: number | null
  backupPath: string | null
  applied: boolean
  error?: string
}

export interface ProjectFoldPlan {
  report: ProjectFoldReport
  /** The names to write before the cast, with `--name-lines`. */
  names: LineToName[]
  /** The `ttsSettings` value to store. */
  nextTts: ProjectTtsSettings
  /** The whole settings blob as read — what the backup holds. */
  settings: Record<string, unknown>
  /** The version the write must match. */
  version: number
}

function byteLength(settings: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(settings), "utf8")
}

/**
 * What folding this project would do. `null` means there is nothing to fold:
 * no cast map, or no line entry that only repeats its character.
 *
 * Only the project-wide map is folded: it is where character sheets write and
 * where the size lives. Per-language casts (AQU-2038) stay small — the voice
 * picker writes only the lines someone picks, and "apply to all" writes the
 * character (`setLaneCharacterCast`).
 */
export async function planProjectFold(
  db: AquillaDb,
  row: Pick<FoldCandidateRow, "project_id" | "project_name">,
  opts: { keepUncastLines?: boolean; nameLines?: boolean } = {},
): Promise<ProjectFoldPlan | null> {
  const loaded = await loadProjectSettings(db, row.project_id)
  const tts = loaded.settings.ttsSettings as ProjectTtsSettings | undefined
  const before = tts?.castAssignments
  if (!tts || !before) return null
  let lines: CastLine[]
  let names: LineToName[] = []
  if (opts.nameLines) {
    // The fold sees each named line as if the name were already written, in
    // document order, so the plan is exactly what the write will produce.
    const { results } = await db.prepare(ALL_LINES_SQL).bind(row.project_id).all<ProjectLineRow>()
    names = planLineNames(tts, results)
    const nameOf = new Map(names.map((n) => [n.cellId, n.castName]))
    lines = []
    for (const r of results) {
      const castName = r.cast_name?.trim() || nameOf.get(r.cell_id)
      if (castName) lines.push({ id: r.cell_id, castName })
    }
  } else {
    lines = await loadCastLines(db, row.project_id)
  }
  const fold = foldCastByCharacter(before, lines, { keepUncastLines: opts.keepUncastLines })
  if (!fold.changed && names.length === 0) return null
  const nextTts: ProjectTtsSettings = { ...tts, castAssignments: fold.castAssignments }
  return {
    report: {
      projectId: row.project_id,
      projectName: row.project_name,
      linesWithCharacter: lines.length,
      linesToName: names.length,
      entriesBefore: Object.keys(before).length,
      entriesAfter: Object.keys(fold.castAssignments).length,
      characterEntries: fold.characterEntries,
      droppedLineEntries: fold.droppedLineEntries,
      newlyVoicedLines: fold.newlyVoicedLines,
      markedLines: fold.markedLines,
      settingsBytesBefore: byteLength(loaded.settings),
      settingsBytesAfter: byteLength({ ...loaded.settings, ttsSettings: nextTts }),
      versionBefore: loaded.version,
      versionAfter: null,
      backupPath: null,
      applied: false,
    },
    names,
    nextTts,
    settings: loaded.settings,
    version: loaded.version,
  }
}
