// AQU-1586: the language a lane translates into lives on the LANE ROW, not in
// the lane's tag.
//
// `cells.target_lang` / the `?targetLang=` query parameter carry a lane's
// `legacy_tag`, which is an event key. `planNewTargetLane`
// (src/lib/lanes/lane-create.ts) sets that tag to the opaque 8-hex lane id
// whenever the language string is already taken by a sibling lane or matches
// the project default — so a second Spanish lane is tagged `a3f09c1e`. Anything
// that passed the tag on as a language asked the model to translate "into
// a3f09c1e".
//
// The resolution rule is the client's (`src/lib/lanes/lane-language.ts`), so
// the preview reports the language the editor would actually send.

import { laneRowLanguage } from '../../../src/lib/lanes/lane-language'

interface LaneRow {
  id: string
  language: string | null
  name: string | null
  lang_code: string | null
  legacy_tag: string | null
}

/**
 * The language of the target lane tagged `legacyTag` in this project, or null
 * when no row carries that tag or the row names no language.
 *
 * The caller falls back to `settings.targetLanguage`: a tag with no row is a
 * lane the registry never recorded, and the project default is a better answer
 * for the model than an opaque key.
 */
export async function laneLanguage(
  db: AquillaDb,
  projectId: string,
  legacyTag: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT id, language, name, lang_code, legacy_tag FROM lanes " +
        "WHERE project_id = ? AND role = 'target' AND legacy_tag = ? LIMIT 1",
    )
    .bind(projectId, legacyTag)
    .first<LaneRow>()
  if (!row) return null
  return laneRowLanguage({
    id: row.id,
    language: row.language,
    name: row.name,
    langCode: row.lang_code,
    legacyTag: row.legacy_tag,
  })
}
