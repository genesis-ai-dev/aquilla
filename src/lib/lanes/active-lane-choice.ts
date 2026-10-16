// AQU-1613: which lane is open, resolved by LANE ID rather than by tag.
//
// The editor historically tracked the open lane as a *tag* — the target
// language string, with `''` standing for "the default lane". Three things
// that rule cannot express, and this module is where each is answered:
//
//  1. **A lane with no tag.** Lanes created since AQU-1240 carry an id and may
//     carry `legacy_tag = null`. Every tagless lane reads back as `''` under the
//     old rule, so a second one is indistinguishable from the former default
//     lane — selecting one selects the other.
//  2. **An archived former default lane.** The old rule falls back to `''`
//     whenever the stored choice is unavailable, which is exactly the lane
//     AQU-1600 makes archivable. The fallback here is "the lane in first
//     position", so there is no lane the client assumes exists.
//  3. **A stored choice that outlives its tag.** A lane may be renamed or have
//     its language edited; its id does not change. An id persists correctly
//     where a tag does not.
//
// Resolution is id-FIRST and tag-TOLERANT: an old stored tag and an old
// `?lane=French` link both still open the right lane, mapped through
// `legacyTag`. History is never rewritten (AQU-1419) — `legacyTag` is the
// permanent bridge, so these mappings keep working indefinitely.
//
// Pure and unit-tested on purpose: ProjectWorkspace is 14k lines, and the rule
// for "which lane opens" is the part that has to be right.

/** The fields of a lane row (`ProjectLaneView`) this resolution needs. */
export interface LaneChoiceRow {
  id: string
  legacyTag: string | null
  position: number
  archivedAt: string | null
}

/** Target lane rows in display order: `position`, then `id` as the tiebreak. */
export function orderedLaneChoices<T extends LaneChoiceRow>(lanes: readonly T[]): T[] {
  return [...lanes].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
}

/**
 * The lane that opens when nothing else names one: the first non-archived lane
 * in position order.
 *
 * Falls back to the first lane of any kind when every lane is archived — a
 * project in that state still has to render something, and an archived lane
 * the user can see beats an editor pointed at nothing. `null` only when the
 * project has no target lane rows at all (a pre-AQU-1418 server, where the
 * caller stays on its tag-based path).
 */
export function firstPositionLaneId(lanes: readonly LaneChoiceRow[]): string | null {
  const ordered = orderedLaneChoices(lanes)
  return ordered.find((lane) => !lane.archivedAt)?.id ?? ordered[0]?.id ?? null
}

/** The tag a lane carries, `''` for a lane that has none. Still the value the
 *  editor filters cells on and the wire carries — the wire moves to lane ids
 *  under its own tickets, and this slice must work before and after that. */
export function laneTagForId(
  laneId: string | null | undefined,
  lanes: readonly LaneChoiceRow[],
): string {
  if (!laneId) return ""
  return lanes.find((lane) => lane.id === laneId)?.legacyTag ?? ""
}

/**
 * The lane a legacy tag names, or `null`.
 *
 * Exact match first, then case-insensitively, so an old `?lane=French` link
 * resolves against a lane stored as `french`. The one normalizer that will
 * answer every "same language?" question lands in AQU-1597; this deliberately
 * stays a plain string comparison rather than guessing a language match — a
 * tag that is not a lane's tag must miss, not land on a near neighbour.
 *
 * A tagless lane (`legacyTag` null) is never matched: `''` names the former
 * default lane only, which is the lane whose stored tag is the empty string.
 */
export function laneIdForTag(
  tag: string,
  lanes: readonly LaneChoiceRow[],
): string | null {
  const ordered = orderedLaneChoices(lanes)
  const exact = ordered.find((lane) => lane.legacyTag === tag)
  if (exact) return exact.id
  const lower = tag.toLowerCase()
  return ordered.find((lane) => lane.legacyTag?.toLowerCase() === lower)?.id ?? null
}

/**
 * The lane a `?lane=` deep link opens (Luke, 2026-10-02):
 *
 * - **missing** (`null`/`undefined`) → `null`: no deep-link intent, keep the
 *   last-used lane. This is the distinction every caller gets wrong, and
 *   `editorCellHref` always emits `?lane=` precisely so a lane-scoped surface
 *   cannot drop the reader into someone else's language.
 * - **empty** (`?lane=`) → the lane in first position.
 * - **a lane id** → that lane.
 * - **an old tag** → the lane that tag belongs to, through `legacyTag`.
 * - **anything else** → the lane in first position; an explicit but unknown
 *   lane still opens the editor rather than leaving it pointed at nothing.
 */
export function resolveDeepLinkLaneId(
  param: string | null | undefined,
  lanes: readonly LaneChoiceRow[],
): string | null {
  if (param === null || param === undefined) return null
  if (param === "") return firstPositionLaneId(lanes)
  return (
    lanes.find((lane) => lane.id === param)?.id ??
    laneIdForTag(param, lanes) ??
    firstPositionLaneId(lanes)
  )
}

/** A persisted lane choice: the id key, plus the tag key written before this
 *  ticket. Both are read once; the resolved id is then written to the id key
 *  and the tag key is dropped. */
export interface StoredLaneChoice {
  /** `aquilla:activeLaneId:<projectId>` — a lane id. */
  laneId: string | null
  /** `aquilla:activeLane:<projectId>` — the legacy tag key. */
  legacyTag: string | null
}

/**
 * The lane a stored choice opens, or `null` to fall back to first position.
 *
 * The id wins when it is still a lane of this project. A stored id for a lane
 * that has since been deleted, or that belongs to another project, resolves
 * through the tag if one was also stored and otherwise misses — in both cases
 * the caller opens first position rather than a lane that is not there.
 *
 * An ARCHIVED lane still resolves: someone who was last reading an archived
 * lane and reloads should land back where they were (reads are allowed;
 * AQU-1462 refuses the writes). Only an absent lane falls back.
 */
export function resolveStoredLaneId(
  stored: StoredLaneChoice,
  lanes: readonly LaneChoiceRow[],
): string | null {
  if (stored.laneId && lanes.some((lane) => lane.id === stored.laneId)) return stored.laneId
  if (stored.legacyTag !== null) return laneIdForTag(stored.legacyTag, lanes)
  return null
}

/**
 * The lane the editor should open, given everything that can name one.
 *
 * Precedence — a deep link is an explicit instruction and outranks the stored
 * choice; the stored choice outranks first position; first position is the
 * floor. The result is `null` only for a project with no target lane rows.
 */
export function resolveOpeningLaneId(
  opts: {
    deepLinkParam?: string | null
    stored?: StoredLaneChoice
    lanes: readonly LaneChoiceRow[]
  },
): string | null {
  const { deepLinkParam = null, stored, lanes } = opts
  const fromLink = resolveDeepLinkLaneId(deepLinkParam, lanes)
  if (fromLink) return fromLink
  const fromStore = stored ? resolveStoredLaneId(stored, lanes) : null
  return fromStore ?? firstPositionLaneId(lanes)
}

// ── Persistence ────────────────────────────────────────────────────────────────
//
// Per-project, per-browser: which lane this reader last had open. Local-only,
// like the rest of the workspace's view preferences — it does not roam.

/** `aquilla:activeLaneId:<projectId>` — a `PersistedLaneChoice`. */
export function activeLaneStorageKey(projectId: string): string {
  return `aquilla:activeLaneId:${projectId}`
}

/**
 * The pre-AQU-1613 key: a bare lane tag, with the default lane stored as "no
 * key at all". Read once, migrated through `legacyTag`, then removed.
 *
 * An ABSENT key therefore means "no stored choice", not "the default lane":
 * the old writer removed the key for `''`, so a reader who never switched and
 * one who deliberately chose the default lane are indistinguishable. Both
 * resolve to first position, which IS the former default lane in any project
 * that has not archived it — the old behaviour, minus the assumption.
 */
export function legacyActiveLaneStorageKey(projectId: string): string {
  return `aquilla:activeLane:${projectId}`
}

/**
 * What is written: the lane's id, plus its tag.
 *
 * The tag is not redundant. Lane rows arrive with the project record, and the
 * editor has to paint a lane before they do — the tag is what it paints with,
 * and it is the fallback when the id cannot be resolved (a choice stored before
 * the rows arrived carries none; a stored id can name a lane since gone).
 * The id wins wherever both are readable.
 */
export interface PersistedLaneChoice {
  laneId: string | null
  tag: string
}

/** The stored choice, plus the tag to paint with until the lane rows land. */
export function readPersistedLaneChoice(projectId: string): StoredLaneChoice & { tag: string } {
  try {
    const raw = localStorage.getItem(activeLaneStorageKey(projectId))
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedLaneChoice> | null
      if (parsed && typeof parsed === "object") {
        const tag = typeof parsed.tag === "string" ? parsed.tag : null
        return {
          laneId: typeof parsed.laneId === "string" ? parsed.laneId : null,
          legacyTag: tag,
          tag: tag ?? "",
        }
      }
    }
    const legacyTag = localStorage.getItem(legacyActiveLaneStorageKey(projectId))
    return { laneId: null, legacyTag, tag: legacyTag ?? "" }
  } catch {
    // Storage unavailable (private mode / quota) — the lane stays in-memory only.
    return { laneId: null, legacyTag: null, tag: "" }
  }
}

/** The tag to paint with before the lane rows arrive. */
export function readPersistedActiveLane(projectId: string): string {
  return readPersistedLaneChoice(projectId).tag
}

/** Store the open lane by id, and drop the pre-AQU-1613 tag key — it is
 *  migrated, never kept in step with this one. */
export function writePersistedActiveLane(
  projectId: string,
  laneId: string | null,
  lane: string,
): void {
  try {
    localStorage.setItem(
      activeLaneStorageKey(projectId),
      JSON.stringify({ laneId, tag: lane } satisfies PersistedLaneChoice),
    )
    localStorage.removeItem(legacyActiveLaneStorageKey(projectId))
  } catch {
    /* storage unavailable (private mode / quota) — lane stays in-memory only */
  }
}
