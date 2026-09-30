/**
 * AQU-1462: an archived lane refuses writes that name it.
 *
 * This is not the write wall. The freeze applies to every role, including
 * Maintainer, and it applies whether or not `LANE_READ_WALL` is on. The
 * default lane (`''`) cannot be archived.
 *
 * The wording does consult the read wall. A caller who is allowed to know the
 * lane exists (wall off, platform, Maintainer+, or a grant at Viewer or
 * above on that lane's id) hears `lane '<name>' is archived`. A caller who is
 * not allowed to know the lane exists — not even its name — hears
 * `lane does not exist`. That reason does not contain the lane's name, tag,
 * or the word "archived". A grant below Viewer does not reveal a lane; that
 * is the same rule as the read wall.
 *
 * Audio, waivers, back-translations, and per-lane retimes are not stored on a
 * lane row. They are frozen only when the event carries a non-empty
 * `targetLang` — the lane the member was working in. An absent tag is a shared
 * write (an import, a source transcription, an event from before this field)
 * and still applies.
 */

import { lanesForRequestedTag, type LaneIdentity } from "./read-wall"

export interface ArchiveLaneRow extends LaneIdentity {
  /** ISO timestamp when the lane is archived. Null or `''` means active. */
  archivedAt: string | null
}

/** Kinds that always address one target lane. An omitted tag is the default lane. */
const ALWAYS_LANE_KINDS = new Set<string>([
  "target.cell.create",
  "target.cell.commit",
  "target.cell.delete",
  "target.cell.reorder",
  "target.cell.repin",
  "cell.validate",
  "cell.unvalidate",
])

/**
 * Kinds checked only when they name a lane. Absent or `''` means the write is
 * shared and is not frozen.
 */
const NAMED_LANE_KINDS = new Set<string>([
  "cell.waive",
  "cell.unwaive",
  "cell.audio.attach",
  "cell.audio.select",
  "cell.audio.remove",
  "cell.audio.rename",
  "cell.audio.trim",
  "cell.audio.place",
  "cell.audio.measure",
  "cell.audio.validate",
  "cell.audio.unvalidate",
  "cell.lane.retime",
  "cell.backtranslation.set",
])

export function archiveCheckApplies(kind: string): boolean {
  return ALWAYS_LANE_KINDS.has(kind) || NAMED_LANE_KINDS.has(kind)
}

/**
 * The lane tag this event is asking to write, or null when the event is not
 * a lane write. `''` is the default lane.
 */
export function laneTagForArchiveCheck(kind: string, payload: unknown): string | null {
  const lang = (payload as { targetLang?: unknown } | null | undefined)?.targetLang
  if (ALWAYS_LANE_KINDS.has(kind)) {
    return typeof lang === "string" ? lang : ""
  }
  if (NAMED_LANE_KINDS.has(kind)) {
    return typeof lang === "string" && lang !== "" ? lang : null
  }
  return null
}

export function archivedTagsFromSettings(
  settings: { archivedLanes?: unknown } | null | undefined,
): string[] {
  const raw = settings?.archivedLanes
  if (!Array.isArray(raw)) return []
  return raw.filter((tag): tag is string => typeof tag === "string" && tag !== "")
}

function listed(tags: readonly string[], value: string): boolean {
  if (value === "") return false
  const needle = value.toLowerCase()
  return tags.some((tag) => tag.toLowerCase() === needle)
}

/**
 * Refusal for a caller who must not learn that the lane exists.
 * No lane name, no tag, and not the word "archived".
 */
export const LANE_DOES_NOT_EXIST_REASON = "lane does not exist"

function rowIsArchived(lane: ArchiveLaneRow, archivedTags: readonly string[]): boolean {
  if (lane.archivedAt != null && lane.archivedAt !== "") return true
  return listed(archivedTags, lane.legacyTag ?? "") || listed(archivedTags, lane.name)
}

/**
 * Stable 403 reason, or null when the write may proceed.
 *
 * `visibleLaneIds` null or omitted means the caller may know every lane
 * (wall off, platform, or Maintainer+). A set is the lane ids a below-Maintainer
 * caller may know. The archived name is used only for an id in that set.
 */
export function archivedLaneReason(input: {
  tag: string
  lanes: readonly ArchiveLaneRow[]
  archivedTags: readonly string[]
  visibleLaneIds?: ReadonlySet<string> | null
}): string | null {
  if (input.tag === "") return null
  const matches = lanesForRequestedTag(input.lanes, input.tag)
  const archivedMatch = matches.find((lane) => lane.archivedAt != null && lane.archivedAt !== "")
  const inSettings =
    listed(input.archivedTags, input.tag) ||
    matches.some(
      (lane) => listed(input.archivedTags, lane.legacyTag ?? "") || listed(input.archivedTags, lane.name),
    )
  if (!archivedMatch && !inSettings) return null

  const visible = input.visibleLaneIds
  if (visible != null) {
    const knowable = matches.find((lane) => visible.has(lane.id) && rowIsArchived(lane, input.archivedTags))
    if (!knowable) return LANE_DOES_NOT_EXIST_REASON
    const display = knowable.name.trim() || input.tag
    return `lane '${display}' is archived`
  }

  const display = (archivedMatch?.name ?? matches[0]?.name ?? "").trim() || input.tag
  return `lane '${display}' is archived`
}
