// AQU-1941 — everything `scripts/neon-prune-phantom-voices.ts` does except the
// I/O: the write gate, where a backup goes, which projects are even worth
// loading, and what one project's prune would do. Kept out of the runner so it
// can be tested — the gate as a pure function, the SQL against PGlite.
//
// The keep rules themselves live in `src/lib/audio/phantom-voices.ts`.
//
// A dry run reads and is never gated. `--apply` rewrites project TTS settings,
// and `scripts/neon-prune-phantom-voices.ts` holds raw `NEON_PG_*` credentials
// without being able to tell which Neon branch they point at — the same blind
// spot `neon-apply-guard.ts#directApplyRefusal` guards for migrations. So the
// operator has to say which database they mean: `neon-target.ts` says it for
// them in `AQUILLA_NEON_TARGET`, a local URL says it, and production has to be
// named out loud with `--production`.

import { loadProjectSettings } from "../db/shared/projects"
import type { AquillaDb } from "../db/shim/postgres"
import { prunePhantomVoices } from "../src/lib/audio/phantom-voices"
import type { ProjectTtsSettings } from "../src/lib/parsers/types"

export const PRODUCTION_FLAG = "--production"

export type PruneGateDecision =
  | { kind: "proceed"; note?: string }
  | { kind: "refuse"; message: string }

export interface PruneGateInput {
  /** Is this run going to write? */
  apply: boolean
  /** `AQUILLA_NEON_TARGET`, as `neon-target.ts` sets it. */
  target: string | undefined
  /** Was `--production` passed? */
  production: boolean
  /** `AQUILLA_LOCAL_PG_URL` — set only for a local Postgres. */
  localUrl: string | undefined
  /** The package script the operator should have run, for the refusal text. */
  applyCommand: string
}

export function decidePruneGate(input: PruneGateInput): PruneGateDecision {
  const { apply, target, production, localUrl, applyCommand } = input

  if (!apply) {
    if (production) {
      return {
        kind: "refuse",
        message:
          `✗ ${PRODUCTION_FLAG} is meaningless without --apply.\n` +
          `  A dry run only reads; drop the flag, or add --apply once you have read the report.`,
      }
    }
    return { kind: "proceed" }
  }

  if (target === "production") {
    if (!production) {
      return {
        kind: "refuse",
        message:
          `✗ Refusing to rewrite TTS settings on Neon production without ${PRODUCTION_FLAG}.\n` +
          `  Read the dry-run report first, then name production out loud:\n\n` +
          `      ${applyCommand} -- --apply ${PRODUCTION_FLAG} --only <projectId>\n`,
      }
    }
    return { kind: "proceed", note: `⚠ applying to Neon PRODUCTION. A settings backup is written per project before each write.` }
  }

  if (production) {
    return {
      kind: "refuse",
      message:
        `✗ ${PRODUCTION_FLAG} was passed but this run is pointed at ` +
        `${target ? `Neon ${target}` : "a database that is not production"}.\n` +
        `  Drop the flag, or re-run the production command.`,
    }
  }

  if (target || localUrl) return { kind: "proceed" }

  return {
    kind: "refuse",
    message:
      `✗ Refusing to rewrite TTS settings on an unidentified database.\n` +
      `  This entry point cannot tell which Neon branch NEON_PG_HOST points at. Use the\n` +
      `  target-aware commands, which name the branch for it:\n\n` +
      `      ${applyCommand}:dev -- --apply --only <projectId>\n` +
      `      ${applyCommand}:prod -- --apply ${PRODUCTION_FLAG} --only <projectId>\n\n` +
      `  Or pass ${PRODUCTION_FLAG} to assert that these credentials ARE production.`,
  }
}

/**
 * Where the pre-write copy of one project's settings goes. The version is in
 * the name so the file says which row it restores, and the timestamp so a
 * second run never silently overwrites the first run's evidence.
 */
export function settingsBackupPath(dir: string, projectId: string, version: number, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const safeProject = projectId.replace(/[^A-Za-z0-9._-]/g, "_")
  return `${dir.replace(/\/+$/, "")}/${safeProject}-v${version}-${stamp}.json`
}

/**
 * Candidate prefilter. Deliberately LOOSER than the keep rules — no canon
 * check, no keep rules at all: its only job is to avoid loading every
 * project's multi-MB settings blob to discover it has no voices in it.
 * `prunePhantomVoices` makes the authoritative decision on what it hands back,
 * so this erring wide costs a read and erring narrow would miss a project.
 *
 * Bound as a parameter rather than inlined because the Postgres shim rewrites
 * every literal `?` into a placeholder (`db/shim/postgres.ts#toPg`) — a `?` in
 * the pattern would silently become `$2`.
 */
export const CANDIDATE_NAME_PATTERN = '^[[:space:]]*[1-3]{0,1}[A-Za-z]{2,3} +[0-9]+:[0-9]+'

export const CANDIDATE_SQL = `SELECT ps.project_id, p.name AS project_name
    FROM project_settings ps
    LEFT JOIN projects p ON p.id = ps.project_id
   WHERE jsonb_typeof(ps.settings::jsonb -> 'ttsSettings' -> 'voices') = 'array'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(ps.settings::jsonb -> 'ttsSettings' -> 'voices') v
        WHERE v ->> 'name' ~ ?
     )`

export interface CandidateRow {
  project_id: string
  project_name: string | null
}

/** The candidate projects, ordered by id so a `--limit` run is repeatable. */
export async function listPruneCandidates(
  db: AquillaDb,
  opts: { onlyProject?: string; limit?: number } = {},
): Promise<CandidateRow[]> {
  let sql = CANDIDATE_SQL
  const binds: unknown[] = [CANDIDATE_NAME_PATTERN]
  if (opts.onlyProject) {
    sql += ` AND ps.project_id = ?`
    binds.push(opts.onlyProject)
  }
  sql += ` ORDER BY ps.project_id`
  if (opts.limit !== undefined) sql += ` LIMIT ${opts.limit}`
  const { results } = await db.prepare(sql).bind(...binds).all<CandidateRow>()
  return results
}

/** One line of the report, whether or not anything was written. */
export interface ProjectPruneReport {
  projectId: string
  projectName: string | null
  totalVoices: number
  versePhantomVoices: number
  keptVoices: number
  assignmentsToDrop: number
  totalAssignments: number
  settingsBytesBefore: number
  settingsBytesAfter: number
  sampleDroppedNames: string[]
  versionBefore: number
  versionAfter: number | null
  backupPath: string | null
  applied: boolean
  error?: string
}

export interface ProjectPrunePlan {
  report: ProjectPruneReport
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
 * What pruning this project would do. `null` means it is clean and must not be
 * written — a prefilter hit whose names are not canonical references, or whose
 * verse-named voices are all kept by a keep rule.
 *
 * The bytes are the WHOLE settings blob, before and after, because that blob is
 * what every member downloads on every workspace open — the voices array's own
 * size is not the number anyone feels.
 */
export async function planProjectPrune(db: AquillaDb, row: CandidateRow): Promise<ProjectPrunePlan | null> {
  const loaded = await loadProjectSettings(db, row.project_id)
  const prune = prunePhantomVoices(loaded.settings.ttsSettings as ProjectTtsSettings | undefined)
  if (prune.clean) return null
  return {
    report: {
      projectId: row.project_id,
      projectName: row.project_name,
      totalVoices: prune.totalVoices,
      versePhantomVoices: prune.droppedVoices,
      keptVoices: prune.keptVoices,
      assignmentsToDrop: prune.droppedAssignments,
      totalAssignments: prune.totalAssignments,
      settingsBytesBefore: byteLength(loaded.settings),
      settingsBytesAfter: byteLength({ ...loaded.settings, ttsSettings: prune.next }),
      sampleDroppedNames: prune.sampleDroppedNames,
      versionBefore: loaded.version,
      versionAfter: null,
      backupPath: null,
      applied: false,
    },
    nextTts: prune.next,
    settings: loaded.settings,
    version: loaded.version,
  }
}
