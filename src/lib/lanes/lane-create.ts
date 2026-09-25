/**
 * AQU-1418: identity of a target lane created from the languages screen.
 *
 * The display name is what people see. `legacy_tag` stays the immutable
 * event key (`target_lang`) until that column is retired. The first lane of
 * a language keeps the language string as its tag, which is what the editor
 * and the external API already write. A second lane of that same language,
 * or a lane whose language is the project's default, gets the opaque lane id
 * as its tag so the two rows do not collide and the default lane (`''`) is
 * left alone.
 */

import { languagesEqual } from "../language-normalize"
import { codeForLanguageLabel } from "./backfill-plan"
import { laneNameProblem, type LaneNameProblem } from "./lane-name"

export interface ExistingLaneIdentity {
  id: string
  name: string
  legacyTag: string | null
}

export type PlanNewTargetLaneResult =
  | { ok: true; name: string; legacyTag: string; langCode: string | null }
  | { ok: false; problem: LaneNameProblem }

export function planNewTargetLane(input: {
  laneId: string
  name: string
  language: string
  targetLanguage: string | null
  existing: readonly ExistingLaneIdentity[]
}): PlanNewTargetLaneResult {
  const language = input.language.trim()
  const name = input.name.trim() || language
  const problem = laneNameProblem({
    laneId: input.laneId,
    name,
    others: input.existing.map((lane) => ({ id: lane.id, name: lane.name })),
  })
  if (problem) return { ok: false, problem }

  const taken = new Set(
    input.existing
      .map((lane) => lane.legacyTag)
      .filter((tag): tag is string => typeof tag === "string"),
  )
  const preferredIsDefault =
    language.length > 0 && languagesEqual(language, input.targetLanguage)
  const legacyTag =
    language.length > 0 && !taken.has(language) && !preferredIsDefault
      ? language
      : input.laneId

  return {
    ok: true,
    name,
    legacyTag,
    langCode: codeForLanguageLabel(language) ?? codeForLanguageLabel(name),
  }
}
