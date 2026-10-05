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

import { laneDisplayName, laneLanguage } from "./lane-display"
import { isLaneId } from "./lane-id"

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
 * `laneLanguage` comes first: the typed `language` column, and for a row that
 * predates it the stored name. A tag or code is used only when that is blank,
 * so editing the language (and leaving the old tag in place) is what the model
 * is told.
 */
export function laneRowLanguage(lane: LaneLanguageRow): string | null {
  const typed = notALaneId(laneLanguage(lane), lane.id)
  if (typed) return typed
  return notALaneId(lane.legacyTag, lane.id) ?? notALaneId(lane.langCode, lane.id)
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
): string | null {
  const row = rowForTag(tag, lanes)
  if (row) return laneRowLanguage(row)
  return tag.trim() || null
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
