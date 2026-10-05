/**
 * AQU-1586: a lane's LANGUAGE and its LABEL both come from its row — and a
 * lane's tag is only ever one of them.
 *
 * `legacy_tag` is the immutable event key (`target_lang`). `planNewTargetLane`
 * (`lane-create.ts`) sets it to the language string when that string is free,
 * and otherwise to the lane's opaque 8-hex id: a second lane of a language, or
 * a lane whose language is the project default, cannot reuse the tag its
 * sibling already holds. So a tag is EITHER a language OR a lane id, never
 * anything else, and reading it blindly as the language drafted the second
 * Spanish lane of a Spanish project "into a3f09c1e" and printed that hex id in
 * lane pickers.
 *
 * Until a lane row carries a real `language` column (AQU-1592), the language of
 * such a lane survives only as `lang_code` — `codeForLanguageLabel` of what the
 * maintainer typed — because `name` must be UNIQUE among the project's lanes
 * and so cannot be the bare language a sibling already goes by. Hence two
 * resolvers with deliberately different precedence:
 *
 *   - `laneRowLanguage` — what we tell the MODEL. The tag when it is a language
 *     (every lane that already worked keeps its exact behavior), else the
 *     `lang_code`, else the name.
 *   - `laneRowLabel` — what we show a PERSON: the display name they chose.
 *
 * Neither ever returns a lane id.
 */

/** The identity fields of a lane row (`ProjectLaneView` / `ProjectRecord.lanes`). */
export interface LaneLanguageRow {
  id: string
  role?: "source" | "target"
  name: string
  langCode: string | null
  legacyTag: string | null
}

/** The source lane's `legacy_tag` is NULL, which reads as the default lane's
 *  `''`, so tag lookups only ever consider target rows. */
function targetRows(lanes: readonly LaneLanguageRow[] | null | undefined): LaneLanguageRow[] {
  return (lanes ?? []).filter((lane) => lane.role !== "source")
}

/** `value` unless it is blank or just the lane's own id. */
function notTheLaneId(value: string | null | undefined, laneId: string): string | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === laneId) return null
  return trimmed
}

/**
 * The language this lane translates into, or `null` when the row records none.
 *
 * The tag comes first ON PURPOSE: for a lane whose tag is its language that is
 * where the language the maintainer typed is stored verbatim, and preferring
 * `lang_code` there would silently rewrite a working lane's "French" into
 * "fra". It is skipped exactly when it is the lane's own id — the case this
 * ticket exists for — and then `lang_code` carries the typed language.
 */
export function laneRowLanguage(lane: LaneLanguageRow): string | null {
  return (
    notTheLaneId(lane.legacyTag, lane.id) ??
    notTheLaneId(lane.langCode, lane.id) ??
    notTheLaneId(lane.name, lane.id)
  )
}

/** The display name to show for this lane, or `null` when the row has none. */
export function laneRowLabel(lane: LaneLanguageRow): string | null {
  return notTheLaneId(lane.name, lane.id) ?? notTheLaneId(lane.langCode, lane.id)
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
