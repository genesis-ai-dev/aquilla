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

import { loadProjectSettings } from "../db/shared/projects"
import type { AquillaDb } from "../db/shim/postgres"
import { foldCastByCharacter, type CastLine } from "../src/lib/audio/character-cast"
import type { ProjectTtsSettings } from "../src/lib/parsers/types"

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

/** One line of the report, whether or not anything was written. */
export interface ProjectFoldReport {
  projectId: string
  projectName: string | null
  linesWithCharacter: number
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
  opts: { keepUncastLines?: boolean } = {},
): Promise<ProjectFoldPlan | null> {
  const loaded = await loadProjectSettings(db, row.project_id)
  const tts = loaded.settings.ttsSettings as ProjectTtsSettings | undefined
  const before = tts?.castAssignments
  if (!tts || !before) return null
  const lines = await loadCastLines(db, row.project_id)
  const fold = foldCastByCharacter(before, lines, { keepUncastLines: opts.keepUncastLines })
  if (!fold.changed) return null
  const nextTts: ProjectTtsSettings = { ...tts, castAssignments: fold.castAssignments }
  return {
    report: {
      projectId: row.project_id,
      projectName: row.project_name,
      linesWithCharacter: lines.length,
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
    nextTts,
    settings: loaded.settings,
    version: loaded.version,
  }
}
