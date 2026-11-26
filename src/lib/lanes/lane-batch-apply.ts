/**
 * AQU-1616 — the lane batch backfill's apply preconditions: which migrations
 * must be in `schema_migrations`, which columns the writes need, the node-pg
 * client config a dry run connects with, and the SQL `--apply` executes.
 *
 * Split out of `lane-batch-backfill.ts` (still well over the ~500 line target)
 * on the same terms as `lane-batch-report.ts`: the planner reads none of these
 * — inside the old file each one's only occurrences were its own declaration
 * and a sibling in this block — so the seam already existed. The planner's
 * module re-exports all six from its own path, so both callers,
 * `scripts/neon-backfill-lane-batch.ts` and the planner's own test, are
 * unaffected.
 *
 * Nothing here imports the planner, so there is no runtime edge back.
 */

export const LANE_BATCH_MIGRATIONS = [
  "0138_project_source_link_lane_id.sql",
  "0152_lane_language.sql",
] as const

export const LANE_BATCH_READ_ONLY_OPTIONS = "-c default_transaction_read_only=on"

/** node-pg client config. Dry run sets the read-only session at startup. */
export function laneBatchClientConfig(
  connectionString: string,
  readOnly: boolean,
): { connectionString: string; options?: string } {
  return readOnly
    ? { connectionString, options: LANE_BATCH_READ_ONLY_OPTIONS }
    : { connectionString }
}

export interface LaneBatchColumnPresence {
  laneLanguage: boolean
  laneNameNullable: boolean
  sourceLinkLaneId: boolean
  audioLaneId: boolean
  audioValidatorLaneId: boolean
  backtranslationLaneId: boolean
}

/**
 * Why `--apply` must refuse. Null means the migrations and the columns this
 * backfill writes are present. 0138 and 0152 are the named gate; the other
 * columns are what the audio and back-translation writes update.
 */
export function laneBatchApplyRefusal(
  appliedMigrations: readonly string[],
  columns: LaneBatchColumnPresence,
): string | null {
  const applied = new Set(appliedMigrations)
  const missingMigrations = LANE_BATCH_MIGRATIONS.filter((name) => !applied.has(name))
  const schemaGaps: string[] = []
  if (!columns.laneLanguage) schemaGaps.push("lanes.language is missing")
  if (!columns.laneNameNullable) schemaGaps.push("lanes.name is still NOT NULL")
  if (!columns.sourceLinkLaneId) schemaGaps.push("projects.source_link_lane_id is missing")
  if (
    missingMigrations.length > 0 ||
    !columns.laneLanguage ||
    !columns.laneNameNullable ||
    !columns.sourceLinkLaneId
  ) {
    const details = [
      ...missingMigrations.map((name) => `not in schema_migrations: ${name}`),
      ...schemaGaps,
    ]
    return (
      "Refusing --apply until migrations 0138_project_source_link_lane_id.sql and " +
      "0152_lane_language.sql are applied.\n" +
      details.join("\n")
    )
  }
  const later: string[] = []
  if (!columns.audioLaneId) later.push("cell_audio.lane_id (migration 0135_cell_audio_lane_id.sql)")
  if (!columns.audioValidatorLaneId) {
    later.push("cell_audio_validators.lane_id (migration 0135_cell_audio_lane_id.sql)")
  }
  if (!columns.backtranslationLaneId) {
    later.push("cell_backtranslations.lane_id (migration 0144_cell_backtranslations_lane_id.sql)")
  }
  if (later.length > 0) {
    return `Refusing --apply: these columns are not on this database:\n${later.join("\n")}`
  }
  return null
}

export const LANE_BATCH_SQL = {
  updateLane:
    "UPDATE lanes SET language = $1, name = $2, lang_code = NULL, updated_at = now() WHERE project_id = $3 AND id = $4",
  updateScope:
    "UPDATE project_member_scopes SET value = $1 WHERE project_id = $2 AND user_id = $3 AND kind = 'lane' AND value = $4",
  deleteScope:
    "DELETE FROM project_member_scopes WHERE project_id = $1 AND user_id = $2 AND kind = 'lane' AND value = $3",
  updateInvite:
    "UPDATE project_invites SET scope_lanes = $1 WHERE token = $2 AND project_id = $3",
  updateLink:
    "UPDATE projects SET source_link_lane_id = $1, updated_at = now() WHERE id = $2 AND source_link_lane_id IS NULL",
  updateAudio:
    "UPDATE cell_audio SET lane_id = $1 WHERE project_id = $2 AND file_id = $3 AND cell_id = $4 AND audio_id = $5 AND lane_id IS NULL",
  updateAudioValidator:
    "UPDATE cell_audio_validators SET lane_id = $1 WHERE project_id = $2 AND file_id = $3 AND cell_id = $4 AND audio_id = $5 AND username = $6 AND lane_id IS NULL",
  updateBacktranslation:
    "UPDATE cell_backtranslations SET lane_id = $1 WHERE project_id = $2 AND file_id = $3 AND cell_id = $4 AND target_event_id = $5 AND lane_id IS NULL",
  updateConcept:
    "UPDATE concepts SET renderings = $1::jsonb WHERE concept_id = $2 AND project_id = $3",
} as const
