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

import { laneLanguage as resolveLaneLanguage, type LaneLanguageSettings } from '../../../src/lib/lanes/lane-display'

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
 * A tag with no row resolves through {@link resolveLaneLanguage} too: the tag
 * itself when it is a language, never when it is an 8-hex lane id, and the
 * former default lane (`''`) through the migration fallback.
 */
export async function laneLanguage(
  db: AquillaDb,
  projectId: string,
  legacyTag: string,
  settings?: LaneLanguageSettings | null,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT id, language, name, lang_code, legacy_tag FROM lanes " +
        "WHERE project_id = ? AND role = 'target' AND legacy_tag = ? LIMIT 1",
    )
    .bind(projectId, legacyTag)
    .first<LaneRow>()
  const resolved = resolveLaneLanguage(
    row
      ? {
          role: "target",
          language: row.language,
          name: row.name,
          langCode: row.lang_code,
        }
      : { role: "target", language: null },
    { settings, role: "target", legacyTag: row?.legacy_tag ?? legacyTag },
  )
  return resolved || null
}
