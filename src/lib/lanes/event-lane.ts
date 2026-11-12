/**
 * AQU-1612: the one resolver that answers "which lane does this event address?".
 *
 * An event names its lane twice.
 *
 *  - `targetLang` is the lane's `legacy_tag`. It is a FROZEN event key: every
 *    pre-1612 event carries it, and the `cells` row key, the AD-2 chain slot
 *    (`chain-claims.ts`) and replay are all still built from it. `''` or an
 *    absent value is the former default lane.
 *  - `laneId` is the lane row's opaque id, stamped by writers from AQU-1612 on.
 *    Lane ids are globally unique (AQU-1606), so an id alone names a lane.
 *
 * Both forms must resolve to the SAME lane. If they could disagree, an old
 * client expressing a lane as a tag and a new client expressing it as an id
 * would compose different `chain_claims.parent_key`s for one cell and both
 * commits would win. So:
 *
 *  1. Prefer `laneId` whenever the project's lane rows are in hand.
 *  2. Fall back to `targetLang` when they are not, or when no id was sent.
 *  3. REJECT an event whose two forms name different lanes, and an event whose
 *     `laneId` is not a lane of this project.
 *
 * The resolved lane is then expressed as its tag, so every key keeps its
 * historical shape. Do not switch the key format — see chain-claims.ts.
 */

import type { LaneIdentity } from "./read-wall"

/** The two lane references an event payload may carry, as sent. */
export interface EventLaneRef {
  /** `payload.laneId` when it is a non-empty string, else null. */
  laneId: string | null
  /** `payload.targetLang` as a tag. `''` is the default lane. */
  tag: string
  /** True when the payload actually carried a string `targetLang`. */
  tagPresent: boolean
}

export type EventLaneResolution =
  | { ok: true; tag: string; laneId: string | null }
  | { ok: false; reason: string }

/** Read both lane references off a payload without resolving them. */
export function eventLaneRef(payload: unknown): EventLaneRef {
  const p = payload as { targetLang?: unknown; laneId?: unknown } | null | undefined
  const rawId = p?.laneId
  const rawTag = p?.targetLang
  return {
    laneId: typeof rawId === "string" && rawId !== "" ? rawId : null,
    tag: typeof rawTag === "string" ? rawTag : "",
    tagPresent: typeof rawTag === "string",
  }
}

/** The lane id an event names, or null when it only named a tag. */
export function eventLaneIdOf(payload: unknown): string | null {
  return eventLaneRef(payload).laneId
}

/**
 * The lane tag of a target-side cell event, with no lane rows to consult.
 *
 * This is the tag-only arm of the resolver and the shape every synchronous
 * key site uses (`laneOfEvent`, the chain slot, the `cells` row key). It is
 * correct because a writer that stamps `laneId` also stamps `targetLang`, and
 * because the perimeter (`authorize`) fills the tag in from the id before an
 * event is stored. Non-target kinds never carry a lane: source rows are shared
 * by every lane.
 */
export function eventLaneTag(kind: string, payload: unknown): string {
  if (!kind.startsWith("target.cell.")) return ""
  return eventLaneRef(payload).tag
}

/**
 * Resolve the lane an event addresses, preferring `laneId`.
 *
 * `lanes` is the project's target lane rows, or null when the caller has none
 * (then the tag is taken as sent). Matching is on `legacy_tag` only — never on
 * a lane's display name, which is not an event key and can change.
 */
export function resolveEventLane(
  payload: unknown,
  lanes: readonly LaneIdentity[] | null,
): EventLaneResolution {
  const ref = eventLaneRef(payload)
  if (ref.laneId === null) return { ok: true, tag: ref.tag, laneId: null }
  if (lanes === null) return { ok: true, tag: ref.tag, laneId: ref.laneId }

  const lane = lanes.find((row) => row.id === ref.laneId)
  if (!lane) return { ok: false, reason: `unknown lane id "${ref.laneId}"` }

  const laneTag = lane.legacyTag ?? ""
  if (ref.tagPresent && ref.tag !== laneTag) {
    return {
      ok: false,
      reason:
        `event names lane id "${ref.laneId}" and target language "${ref.tag}", ` +
        `but that lane's language is "${laneTag}"`,
    }
  }
  return { ok: true, tag: laneTag, laneId: lane.id }
}
