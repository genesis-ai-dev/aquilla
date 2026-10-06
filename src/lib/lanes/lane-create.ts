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
 *
 * AQU-1592: the plan stores only what the user typed — the language, plus a
 * name and a code override ONLY when they set one. A derived display name and
 * a derived language code are never part of the plan, because a code captured
 * here keeps claiming the old language after the label is edited (AQU-1585).
 * The language is required; the name is optional and the language stands in
 * for it; the code override must be a well-formed BCP 47 tag.
 */

import { languagesEqual } from "../language-normalize"
import { canonicalLanguageCodeOverride, laneDisplayName } from "./lane-display"
import { laneNameProblem, type LaneNameProblem } from "./lane-name"

export interface ExistingLaneIdentity {
  id: string
  /** AQU-1592: null on a lane that only carries a language. */
  name: string | null
  /** AQU-1592: null on a row that predates migration 0150. */
  language?: string | null
  legacyTag: string | null
}

export type NewTargetLaneProblem = LaneNameProblem | "malformed_code"

export type PlanNewTargetLaneResult =
  | {
      ok: true
      /** Stored as typed. Required. */
      language: string
      /** Stored only when the user gave one; null means "display the language". */
      name: string | null
      legacyTag: string
      /** Stored only when the user set one; null means "derive on read". */
      langCode: string | null
    }
  | { ok: false; problem: NewTargetLaneProblem }

export function planNewTargetLane(input: {
  laneId: string
  /** Optional display override. Blank means "just show the language". */
  name: string
  /** Required. The freeform language the lane translates into. */
  language: string
  /** Optional BCP 47 override from the "Advanced" disclosure. */
  code?: string | null
  targetLanguage: string | null
  existing: readonly ExistingLaneIdentity[]
}): PlanNewTargetLaneResult {
  const language = input.language.trim()
  const name = input.name.trim() || null

  // Uniqueness is on what people SEE, so a new lane showing only its language
  // still collides with an existing lane whose name renders the same string.
  const display = laneDisplayName({ role: "target", language, name })
  const problem = laneNameProblem({
    laneId: input.laneId,
    name: language || name ? display : "",
    others: input.existing.map((lane) => ({ id: lane.id, name: laneDisplayName(lane) })),
  })
  if (problem) return { ok: false, problem }

  const override = canonicalLanguageCodeOverride(input.code)
  if (!override.ok) return { ok: false, problem: "malformed_code" }

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

  return { ok: true, language, name, legacyTag, langCode: override.code }
}
