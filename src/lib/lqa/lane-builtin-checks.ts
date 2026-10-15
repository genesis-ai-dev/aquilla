// What the built-in checks resolve PER TARGET LANE (AQU-1906).
//
// Two lane-scoped answers, both read where the rule set is built (useRules,
// and the Rules page for its own viewed lane) rather than per cell:
//
//   * the lane's punctuation conventions — the marks the two punctuation
//     checks judge the target by (db/shared/punctuation-conventions.ts);
//   * the lane's built-in check overrides — a maintainer may switch a check
//     off, or change its severity, for ONE lane, on top of the project-wide
//     `algorithmicChecks` every lane already shared.
//
// Pure: no React, no network.

import type {
  AlgorithmicCheckOverride,
  BuiltinCheckId,
  ProjectRecord,
} from "@/lib/parsers/types"
import { laneLanguage, laneLanguageCode } from "@/lib/lanes/lane-display"
import { readLanguageProfile } from "../../../db/shared/language-profile"
import { resolvePunctuation, type ResolvedPunctuation } from "../../../db/shared/punctuation-conventions"

type LaneRow = NonNullable<ProjectRecord["lanes"]>[number]

/** Overrides keyed by check id, as `algorithmicChecks` holds them. */
export type CheckOverrides = Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>>

/** Per-lane overrides, keyed by the lane's legacy tag (`''` = the default lane). */
export type CheckOverridesByLane = Record<string, CheckOverrides>

/** The target lane row for `lane` ('' = the default lane), or undefined. */
export function targetLaneRow(
  lanes: readonly LaneRow[] | undefined,
  lane: string,
): LaneRow | undefined {
  return lanes?.find((row) => row.role === "target" && (row.legacyTag ?? "") === lane)
}

/**
 * The language to judge a lane's punctuation by: the lane row's code when a
 * catalog entry matches, else the freeform label the user typed, else — for the
 * default lane of a project whose lane rows have not arrived yet (`lanes` is
 * absent until the settings read returns) — the project's target language.
 *
 * Returning the label when no code matches is deliberate: `resolvePunctuation`
 * resolves "Thai" as readily as "th", so a lane whose freeform language the
 * catalog does not list still gets its conventions.
 */
export function laneLanguageForChecks(
  project: Pick<ProjectRecord, "lanes" | "targetLanguage"> | null | undefined,
  lane: string,
): string {
  const row = targetLaneRow(project?.lanes, lane)
  if (row) {
    const context = { role: "target" as const, legacyTag: row.legacyTag }
    return laneLanguageCode(row, context) ?? laneLanguage(row, context)
  }
  return lane === "" ? (project?.targetLanguage ?? "") : lane
}

/**
 * The lane's language as a person reads it — the label the user typed, else the
 * project's target language for the default lane. For UI copy only; the checks
 * resolve by {@link laneLanguageForChecks}.
 */
export function laneLanguageLabel(
  project: Pick<ProjectRecord, "lanes" | "targetLanguage"> | null | undefined,
  lane: string,
): string {
  const row = targetLaneRow(project?.lanes, lane)
  if (row) return laneLanguage(row, { role: "target", legacyTag: row.legacyTag })
  return lane === "" ? (project?.targetLanguage ?? "") : lane
}

/**
 * The punctuation conventions in force in `lane`: the project's Language
 * profile slot when it is filled, else the table entry for the lane's
 * language, else none (which keeps the pre-AQU-1906 source-relative checks).
 *
 * The Language profile is a PROJECT-level record, so a filled slot applies in
 * every lane — that is what "the profile wins over the table" means here.
 */
export function lanePunctuation(
  project: Pick<ProjectRecord, "lanes" | "targetLanguage" | "languageProfile"> | null | undefined,
  lane: string,
): ResolvedPunctuation {
  return resolvePunctuation({
    language: laneLanguageForChecks(project, lane),
    profile: readLanguageProfile(project?.languageProfile).punctuation ?? null,
  })
}

/**
 * The built-in check overrides in force in `lane`: the lane's own entries laid
 * over the project-wide ones, per check id (a lane entry REPLACES the project
 * entry for that check, rather than merging field by field — a lane that sets
 * only `enabled` means exactly that, with the registry default severity).
 *
 * `lane === undefined` is a management surface asking for the project-wide set
 * (`useRules`' own convention), so nothing lane-scoped is applied.
 */
export function laneCheckOverrides(
  project: Pick<ProjectRecord, "algorithmicChecks" | "algorithmicChecksByLane"> | null | undefined,
  lane: string | undefined,
): CheckOverrides | undefined {
  const base = project?.algorithmicChecks
  if (lane === undefined) return base
  const perLane = project?.algorithmicChecksByLane?.[lane]
  if (!perLane || Object.keys(perLane).length === 0) return base
  return { ...base, ...perLane }
}

/**
 * The map to store after a maintainer changes one check in one lane. Setting a
 * lane's override to the project-wide value is still an override — the point
 * of the control is that the lanes stop sharing — so nothing is pruned here
 * except an empty lane entry, which would otherwise accumulate.
 */
export function withLaneOverride(
  stored: CheckOverridesByLane | undefined,
  lane: string,
  checkId: BuiltinCheckId,
  override: AlgorithmicCheckOverride,
): CheckOverridesByLane {
  return { ...stored, [lane]: { ...stored?.[lane], [checkId]: override } }
}
