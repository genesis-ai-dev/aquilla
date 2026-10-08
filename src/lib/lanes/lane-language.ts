/**
 * AQU-1586 / AQU-1592: a lane's language and its label both come from its row.
 *
 * `legacy_tag` is the immutable event key (`target_lang`). It is the language
 * string when that string was free, and the opaque 8-hex lane id otherwise.
 * Reading the tag as the language drafted a second Spanish lane "into
 * a3f09c1e".
 *
 * What we tell the model is `laneLanguage` — the typed `language` column, else
 * the name a row stored before that column existed. What we show a person is
 * `laneDisplayName`. A tag or a `lang_code` is only a fallback when those are
 * blank, and an 8-hex lane id is never either answer.
 */

import {
  hasLaneCodeOverride,
  laneDisplayName,
  laneLanguage,
  laneLanguageCode,
  type LaneLanguageSettings,
} from "./lane-display"
import { isLaneId } from "./lane-id"
import { laneLabelSuffixes } from "./lane-label-suffix"

/** The identity fields of a lane row (`ProjectLaneView` / `ProjectRecord.lanes`). */
export interface LaneLanguageRow {
  id: string
  role?: "source" | "target"
  /** Freeform language the user typed. Null on a row that predates the column. */
  language?: string | null
  /** Optional display override. Null means "display the language". */
  name?: string | null
  langCode?: string | null
  legacyTag: string | null
}

/** The source lane's `legacy_tag` is NULL, which reads as the default lane's
 *  `''`, so tag lookups only ever consider target rows. */
function targetRows(lanes: readonly LaneLanguageRow[] | null | undefined): LaneLanguageRow[] {
  return (lanes ?? []).filter((lane) => lane.role !== "source")
}

/** `value` unless it is blank or an opaque lane id (this row's, or any 8-hex id). */
function notALaneId(value: string | null | undefined, laneId: string): string | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === laneId || isLaneId(trimmed)) return null
  return trimmed
}

/**
 * The language this lane translates into, or `null` when the row records none.
 *
 * Every answer comes from {@link laneLanguage}: the typed column, then
 * name → tag → code. Settings are not read. An 8-hex lane id is never that
 * answer.
 */
export function laneRowLanguage(
  lane: LaneLanguageRow,
  settings?: LaneLanguageSettings | null,
): string | null {
  const resolved = laneLanguage(lane, {
    settings,
    role: lane.role,
    legacyTag: lane.legacyTag,
  })
  return resolved || null
}

/**
 * The display name to show for this lane, or `null` when the row has none.
 * A blank row is null rather than the role placeholder, so a picker's own
 * fallback still applies.
 */
export function laneRowLabel(lane: LaneLanguageRow): string | null {
  if (!(lane.name ?? "").trim() && !(lane.language ?? "").trim()) return null
  return notALaneId(laneDisplayName(lane), lane.id)
}

/** The row carrying `tag`, matched on `legacy_tag` ('' is the default lane). */
function rowForTag(
  tag: string,
  lanes: readonly LaneLanguageRow[] | null | undefined,
): LaneLanguageRow | null {
  const rows = targetRows(lanes)
  // A lane tagged with its own id is the bug case, so match on the id too: a
  // caller holding the id rather than the tag resolves to the same row.
  return (
    rows.find((lane) => (lane.legacyTag ?? "") === tag) ?? rows.find((lane) => lane.id === tag) ?? null
  )
}

/**
 * The language of the lane carrying `tag`, or `null` when nothing names one.
 *
 * Falls back to `tag` itself only when NO row matches — without rows the tag is
 * all a caller has, which is what every surface did before AQU-1418.
 */
export function laneLanguageForTag(
  tag: string,
  lanes: readonly LaneLanguageRow[] | null | undefined,
  settings?: LaneLanguageSettings | null,
): string | null {
  const row = rowForTag(tag, lanes)
  if (row) return laneRowLanguage(row, settings)
  // No row: the tag is all a caller has (a server that predates lane rows),
  // except an 8-hex id, which is never a language. `''` is the former default
  // lane's tag, not a language, and settings are not consulted.
  const resolved = laneLanguage(
    { role: "target", language: null },
    { settings, role: "target", legacyTag: tag },
  )
  return resolved || null
}

/**
 * The label a picker shows for the lane carrying `tag`.
 *
 * Always a string: an unresolvable lane falls back to its tag, because a blank
 * option is worse than an opaque one. With rows present that fallback is
 * unreachable for any lane the maintainer named.
 */
export function laneLabelForTag(
  tag: string,
  lanes: readonly LaneLanguageRow[] | null | undefined,
): string {
  const row = rowForTag(tag, lanes)
  return (row ? laneRowLabel(row) : null) ?? tag
}

/**
 * `legacy_tag` → display name, for the surfaces that label lanes through a map
 * (`AssignModal`, `EditorTable`, `RuleEditor`). Lanes whose row names nothing
 * are left out, so the consumer's own `?? tag` fallback still applies.
 */
export function laneLabelsByTag(
  lanes: readonly LaneLanguageRow[] | null | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const lane of targetRows(lanes)) {
    const label = laneRowLabel(lane)
    if (label) labels[lane.legacyTag ?? ""] = label
  }
  return labels
}

/**
 * `legacy_tag` → the lane's code OVERRIDE, for the surfaces that tell two
 * same-named lanes apart by it (AQU-1784). Only an override is included: a
 * code DERIVED from the language is the same string for both colliding lanes,
 * so it distinguishes nothing and is left out rather than offered as a suffix.
 */
export function laneCodesByTag(
  lanes: readonly LaneLanguageRow[] | null | undefined,
): Record<string, string> {
  const codes: Record<string, string> = {}
  for (const lane of targetRows(lanes)) {
    if (!hasLaneCodeOverride(lane)) continue
    const code = laneLanguageCode(lane)
    if (code) codes[lane.legacyTag ?? ""] = code
  }
  return codes
}

/**
 * Lane id → the suffix that tells a lane apart from a sibling showing the same
 * string (AQU-1784), for the surfaces that hold lane ROWS rather than tags —
 * the languages screen.
 *
 * `lanes` must already be in REGISTRY order (`position`, then id), which is
 * the order the lane switcher offers them in, so the two surfaces number one
 * collision the same way. Lanes whose label is unique are left out, so a
 * caller's `?? null` keeps rendering them untouched.
 */
export function laneLabelSuffixesById(
  lanes: readonly LaneLanguageRow[] | null | undefined,
): Record<string, string> {
  const rows = targetRows(lanes)
  const suffixes = laneLabelSuffixes(
    rows.map((lane) => ({
      label: laneDisplayName(lane),
      code: hasLaneCodeOverride(lane) ? laneLanguageCode(lane) : null,
    })),
  )
  const byId: Record<string, string> = {}
  for (const [index, lane] of rows.entries()) {
    const suffix = suffixes[index]
    if (suffix) byId[lane.id] = suffix
  }
  return byId
}
