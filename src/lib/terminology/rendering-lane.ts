/**
 * Which lane a rendering belongs to.
 *
 * Concepts and source terms stay project-level. A rendering carries `laneId`
 * (`lanes.id`). When that field is missing — every rendering written before
 * the lane stamp — it belongs to the project's target lane whose
 * `legacy_tag` is `''`. That row is the permanent bridge: events are never
 * rewritten, and readers use this function until the backfill (AQU-1616)
 * has re-folded the projection.
 *
 * A termbase a project SUBSCRIBES to (AQU-1721) is another project with its
 * own lanes, so its renderings carry the termbase's lane ids, which never
 * equal the subscriber's. `mapSubscribedConceptLanes` rewrites them onto the
 * subscriber's lanes by language before any of the filters below run
 * (AQU-1777).
 *
 * Keep this module free of `@/` aliases. The fold and the workers import it.
 */

import { languagesEqual } from "../../../db/shared/language-normalize"
import { laneRowLanguage, type LaneLanguageRow } from "../lanes/lane-language"

export interface RenderingLaneRef {
  id: string
  role?: "source" | "target"
  /** Exact `lanes.legacy_tag`. `null` is the source lane, not `''`. */
  legacyTag?: string | null
}

export interface RenderingWithLane {
  laneId?: string | null
}

/** The lane id a rendering is read as. A non-empty `laneId` wins. */
export function renderingLaneId(
  rendering: RenderingWithLane,
  legacyEmptyLaneId: string,
): string {
  const id = rendering.laneId
  if (typeof id === "string" && id !== "") return id
  return legacyEmptyLaneId
}

/** Stamp a missing lane id. A null bridge id leaves the rendering alone. */
export function stampRenderingLane<T>(
  rendering: T,
  legacyEmptyLaneId: string | null,
): T {
  const current = rendering as T & RenderingWithLane
  if (!legacyEmptyLaneId) return rendering
  if (typeof current.laneId === "string" && current.laneId !== "") return rendering
  return { ...current, laneId: legacyEmptyLaneId }
}

export function stampRenderingLanes<T>(
  renderings: readonly T[],
  legacyEmptyLaneId: string | null,
): T[] {
  if (!legacyEmptyLaneId) return renderings.slice()
  return renderings.map((rendering) => stampRenderingLane(rendering, legacyEmptyLaneId))
}

export function renderingsForLane<T>(
  renderings: readonly T[],
  laneId: string,
  legacyEmptyLaneId: string,
): T[] {
  return renderings.filter(
    (rendering) => renderingLaneId(rendering as RenderingWithLane, legacyEmptyLaneId) === laneId,
  )
}

export function conceptsForLane<T extends { renderings: readonly unknown[] }>(
  concepts: readonly T[],
  laneId: string,
  legacyEmptyLaneId: string,
): T[] {
  return concepts.map((concept) => ({
    ...concept,
    renderings: renderingsForLane(concept.renderings, laneId, legacyEmptyLaneId),
  }))
}

/**
 * Replace one lane's slice inside the stored list. Other lanes stay, in
 * their original order. The new slice is stamped with `laneId` and written
 * where that lane's renderings used to sit.
 */
export function replaceLaneRenderings<T>(
  all: readonly T[],
  laneId: string,
  legacyEmptyLaneId: string,
  nextSlice: readonly T[],
): T[] {
  const stamped = nextSlice.map((rendering) =>
    stampRenderingLane({ ...(rendering as T & RenderingWithLane), laneId }, legacyEmptyLaneId),
  )
  const out: T[] = []
  let placed = false
  for (const rendering of all) {
    if (renderingLaneId(rendering as RenderingWithLane, legacyEmptyLaneId) !== laneId) {
      out.push(rendering)
      continue
    }
    if (!placed) {
      out.push(...stamped)
      placed = true
    }
  }
  if (!placed) out.push(...stamped)
  return out
}

/** Id of the target lane whose `legacy_tag` is exactly `''`, or null. */
export function legacyEmptyLaneId(lanes: readonly RenderingLaneRef[]): string | null {
  return laneIdForLegacyTag("", lanes)
}

/** Exact `legacyTag` match. Source rows are skipped. `null` is not `''`. */
export function laneIdForLegacyTag(
  tag: string,
  lanes: readonly RenderingLaneRef[],
): string | null {
  const row = lanes.find((lane) => lane.role !== "source" && lane.legacyTag === tag)
  return row?.id ?? null
}

/**
 * Filter concepts to the lane named by a legacy tag.
 *
 * No `''` row yet: return the list unchanged (a shallow copy). A tag that
 * names no row: empty renderings, so an unknown lane does not inherit the
 * unstamped ones.
 */
export function conceptsForLaneTag<T extends { renderings: readonly unknown[] }>(
  concepts: readonly T[],
  laneTag: string,
  lanes: readonly RenderingLaneRef[],
): T[] {
  const emptyId = legacyEmptyLaneId(lanes)
  if (!emptyId) return concepts.slice()
  const activeId = laneIdForLegacyTag(laneTag, lanes)
  if (!activeId) return concepts.map((concept) => ({ ...concept, renderings: [] }))
  return conceptsForLane(concepts, activeId, emptyId)
}

// ── Subscribed termbases (AQU-1777) ──────────────────────────────────────────

/** Target rows only. The source lane's null tag is not the `''` bridge. */
function targetLanes(lanes: readonly LaneLanguageRow[]): LaneLanguageRow[] {
  return lanes.filter((lane) => lane.role !== "source")
}

/**
 * Does a termbase lane carry the same language as a subscriber lane?
 *
 * Both languages known (AQU-1592's reader: the typed column, else the name,
 * else a tag that is a language string): the AQU-1597 normalizer decides, so
 * "Spanish", "spanish" and "es" are one language. Either unknown: the two
 * `legacy_tag`s must be byte-equal, which is how two un-backfilled `''`
 * lanes still find each other.
 */
export function subscribedLanesMatch(
  termbaseLane: LaneLanguageRow,
  subscriberLane: LaneLanguageRow,
): boolean {
  const termbaseLanguage = laneRowLanguage(termbaseLane)
  const subscriberLanguage = laneRowLanguage(subscriberLane)
  if (termbaseLanguage && subscriberLanguage) {
    return languagesEqual(termbaseLanguage, subscriberLanguage)
  }
  return termbaseLane.legacyTag != null && termbaseLane.legacyTag === subscriberLane.legacyTag
}

/**
 * The termbase lanes a rendering is visible in on the TERMBASE's own
 * surfaces: the lane its `laneId` names, else the termbase's `''` bridge
 * lane. A termbase with no `''` lane has not grown lanes — `conceptsForLaneTag`
 * leaves its lists unfiltered there — so every target lane shows every
 * rendering. `lanes` is already target-only.
 */
function termbaseLanesShowing(
  rendering: RenderingWithLane,
  lanes: readonly LaneLanguageRow[],
): readonly LaneLanguageRow[] {
  const emptyId = legacyEmptyLaneId(lanes)
  if (!emptyId) return lanes
  const laneId = renderingLaneId(rendering, emptyId)
  const lane = lanes.find((candidate) => candidate.id === laneId)
  return lane ? [lane] : []
}

/**
 * Map a subscribed termbase's concepts onto the subscriber's lanes.
 *
 * Each rendering is re-stamped with the id of every subscriber lane whose
 * language matches a termbase lane that shows it ({@link subscribedLanesMatch});
 * one copy per such lane, and a rendering no subscriber lane matches is
 * dropped. The bridge rule for a missing `laneId` is applied against the
 * TERMBASE's lanes, never the subscriber's. After this, `conceptsForLane` /
 * `conceptsForLaneTag` treat the result exactly like the subscriber's own
 * concepts, so no consumer needs to know which concepts are subscribed.
 *
 * With no target lane rows on either side the mapping has nothing to key on
 * and returns the concepts unchanged (shallow copies): the AQU-1508 "not grown
 * lanes" rule, on whichever side lacks them.
 */
export function mapSubscribedConceptLanes<T extends { renderings: readonly unknown[] }>(
  concepts: readonly T[],
  termbaseLanes: readonly LaneLanguageRow[],
  subscriberLanes: readonly LaneLanguageRow[],
): T[] {
  const termbase = targetLanes(termbaseLanes)
  const subscriber = targetLanes(subscriberLanes)
  if (termbase.length === 0 || subscriber.length === 0) {
    return concepts.map((concept) => ({ ...concept }))
  }
  // Each termbase lane's matching subscriber lane ids, resolved once per call.
  const matches = new Map<string, string[]>()
  for (const lane of termbase) {
    matches.set(
      lane.id,
      subscriber.filter((candidate) => subscribedLanesMatch(lane, candidate)).map((c) => c.id),
    )
  }
  return concepts.map((concept) => {
    const renderings: unknown[] = []
    for (const rendering of concept.renderings) {
      const stamped = new Set<string>()
      for (const lane of termbaseLanesShowing(rendering as RenderingWithLane, termbase)) {
        for (const laneId of matches.get(lane.id) ?? []) {
          if (stamped.has(laneId)) continue
          stamped.add(laneId)
          renderings.push({ ...(rendering as object), laneId })
        }
      }
    }
    return { ...concept, renderings }
  })
}
