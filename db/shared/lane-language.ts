// The language a model should be told for one target lane.
//
// The rule lives in `laneRowLanguage` (src/lib/lanes/lane-language.ts): the
// typed `lanes.language` wins (AQU-1592, AQU-1593). This file only loads the
// row, and it has to load that column or the rule never sees it.

import type { AquillaDb } from "../shim/postgres"
import { laneRowLanguage } from "../../src/lib/lanes/lane-language"
import { resolveLaneIdOrTag } from "./lane-ref"

interface LaneSqlRow {
  id: string
  language: string | null
  name: string
  lang_code: string | null
  legacy_tag: string | null
}

/** Language of one target lane row, or null when the row names none. */
export async function languageOfTargetLane(
  db: AquillaDb,
  projectId: string,
  laneId: string | null | undefined,
): Promise<string | null> {
  const id = (laneId ?? "").trim()
  if (!id) return null
  const row = await db
    .prepare(
      `SELECT id, language, name, lang_code, legacy_tag FROM lanes
        WHERE project_id = ? AND id = ? AND role = 'target'`,
    )
    .bind(projectId, id)
    .first<LaneSqlRow>()
  if (!row) return null
  return laneRowLanguage({
    id: row.id,
    role: "target",
    language: row.language,
    name: row.name,
    langCode: row.lang_code,
    legacyTag: row.legacy_tag,
  })
}

/**
 * Language to put in a prompt for this lane.
 *
 * A lane id wins over the legacy tag. The row's language wins over both, so a
 * second lane of a language — whose tag is its own id — is named by
 * `lang_code` / `name`, never by that hex id. With no row, a tag that is not
 * an id is still the language older callers passed. Otherwise the project's
 * target language.
 */
export async function modelLanguageForLane(
  db: AquillaDb,
  projectId: string,
  lane: { laneId?: string | null; tag?: string | null },
  projectLanguage?: string | null,
): Promise<string | undefined> {
  const laneId = (lane.laneId ?? "").trim()
  const tag = (lane.tag ?? "").trim()
  const key = laneId || tag
  if (key) {
    const resolved = await resolveLaneIdOrTag(db, projectId, key)
    if (resolved.laneId) {
      const fromRow = await languageOfTargetLane(db, projectId, resolved.laneId)
      if (fromRow) return fromRow
    }
  }
  if (tag && tag !== laneId) return tag
  const project = projectLanguage?.trim()
  return project || undefined
}
