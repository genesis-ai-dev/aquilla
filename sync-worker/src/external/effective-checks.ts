// The checks in force for a project (AQU-2192), for the Agent API's settings
// read.
//
// The stored `algorithmicChecks` blob holds only overrides: a built-in check
// that is on by default is never written, so an agent reading the raw blob
// could not tell what was active. This resolves defaults + overrides with the
// same table and rules the Rules page uses (db/shared/builtin-checks.ts).

import {
  effectiveChecks,
  mergeLaneOverrides,
  type EffectiveCheck,
} from '../../../db/shared/builtin-checks'
import { readBibleEnrichments, resolveBibleEnrichment } from '../../../db/shared/bible-enrichments'
import { visibleTagsForMember } from '../../../db/shared/lane-visibility'

export interface EffectiveChecksView {
  /** Project-wide checks: every default with `algorithmicChecks` laid over it. */
  builtinChecks: EffectiveCheck[]
  /** Only lanes with entries in `algorithmicChecksByLane`, keyed by lane tag ("" = default lane). */
  builtinChecksByLane: Record<string, EffectiveCheck[]>
}

/** Mirrors SCRIPTURE_FILE_KINDS in auth-worker/src/lib/aquifer/gate.ts (and SCRIPTURE_FILE_TYPES in the SPA). */
const SCRIPTURE_FILE_KINDS = ['usfm', 'ebible', 'helloao', 'codex'] as const

async function projectHasScriptureFiles(db: AquillaDb, projectId: string): Promise<boolean> {
  const placeholders = SCRIPTURE_FILE_KINDS.map(() => '?').join(',')
  const row = await db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM files
          WHERE project_id = ?
            AND deleted_at IS NULL
            AND (
              kind IN (${placeholders})
              OR meta::jsonb -> 'aquillaImport' ->> 'hasScriptureContent' = 'true'
            )
       ) AS has_scripture`,
    )
    .bind(projectId, ...SCRIPTURE_FILE_KINDS)
    .first<{ has_scripture: boolean }>()
  return row?.has_scripture === true
}

/**
 * Are the Bible data checks listed for this project? The same predicate the
 * SPA uses (`bibleChecksEnabled`): the Bible data switch is on (explicit, else
 * derived from scripture files) and the "checks" enrichment is on. The SPA
 * also needs the device's Bible data experiment flag, which has no server
 * counterpart.
 */
async function bibleChecksOn(db: AquillaDb, projectId: string, settings: Record<string, unknown>): Promise<boolean> {
  const explicit = settings.bibleResourcesEnabled
  const hasScriptureFiles = typeof explicit === 'boolean' ? false : await projectHasScriptureFiles(db, projectId)
  return resolveBibleEnrichment(
    {
      bibleResourcesEnabled: typeof explicit === 'boolean' ? explicit : undefined,
      bibleEnrichments: readBibleEnrichments(settings.bibleEnrichments),
    },
    'checks',
    hasScriptureFiles,
  )
}

/**
 * `settings` is the RAW stored blob. Lane keys the caller cannot see (AQU-1421
 * read wall) are left out of `builtinChecksByLane`, as a hidden lane is absent
 * everywhere else on this API.
 */
export async function loadEffectiveChecks(
  db: AquillaDb,
  flag: string | undefined,
  projectId: string,
  userId: number,
  role: number,
  settings: Record<string, unknown>,
): Promise<EffectiveChecksView> {
  const bibleChecks = await bibleChecksOn(db, projectId, settings)
  const options = { bibleChecks }
  const builtinChecks = effectiveChecks(settings.algorithmicChecks, options)

  const byLane = settings.algorithmicChecksByLane
  const builtinChecksByLane: Record<string, EffectiveCheck[]> = {}
  if (typeof byLane === 'object' && byLane !== null && !Array.isArray(byLane)) {
    const { visible, lanes } = await visibleTagsForMember(db, flag, projectId, userId, role)
    for (const [tag, entries] of Object.entries(byLane)) {
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue
      if (Object.keys(entries).length === 0) continue
      if (visible !== null && !lanes.some((l) => (l.legacyTag ?? '') === tag && visible.has(l.id))) continue
      builtinChecksByLane[tag] = effectiveChecks(mergeLaneOverrides(settings.algorithmicChecks, entries), options)
    }
  }
  return { builtinChecks, builtinChecksByLane }
}
