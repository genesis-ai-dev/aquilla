// AQU-1593: load lane rows and ask laneLanguage. This file does not decide
// what a language is — src/lib/lanes/lane-display.ts does.

import { laneLanguage } from "../../../src/lib/lanes/lane-display"
import { laneLanguageForTag, type LaneLanguageRow } from "../../../src/lib/lanes/lane-language"

export interface LaneLanguageDb {
  prepare(query: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>
      all<T>(): Promise<{ results: T[] }>
    }
  }
}

interface LaneSqlRow {
  id: string
  role: string
  language: string | null
  name: string | null
  lang_code: string | null
  legacy_tag: string | null
}

export async function loadLaneRows(db: LaneLanguageDb, projectId: string): Promise<LaneLanguageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, role, language, name, lang_code, legacy_tag
         FROM lanes WHERE project_id = ?`,
    )
    .bind(projectId)
    .all<LaneSqlRow>()
  return (results ?? []).map((row) => ({
    id: row.id,
    role: row.role === "source" ? "source" : "target",
    language: row.language,
    name: row.name,
    langCode: row.lang_code,
    legacyTag: row.legacy_tag,
  }))
}

/**
 * Source-lane language and the language of the lane tagged `targetTag`, read
 * off the lane rows alone. AQU-2223: the retired settings language keys are
 * not a fallback — a project without lane rows is a data bug to fix.
 */
export function languagesForLanes(
  lanes: readonly LaneLanguageRow[],
  targetTag: string,
): { sourceLanguage?: string; targetLanguage?: string } {
  const sourceLane = lanes.find((lane) => lane.role === "source")
  const sourceLanguage = laneLanguage(sourceLane ?? { role: "source" }, {
    role: "source",
    legacyTag: sourceLane?.legacyTag ?? null,
  })
  const targetLanguage = laneLanguageForTag(targetTag, lanes) ?? ""
  return {
    ...(sourceLanguage ? { sourceLanguage } : {}),
    ...(targetLanguage ? { targetLanguage } : {}),
  }
}
