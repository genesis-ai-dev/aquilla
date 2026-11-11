/**
 * AQU-2205: the lane read wall covers per-lane check overrides and
 * lane-scoped rules.
 *
 * Two `settings` keys carry a lane tag and used to pass the wall untouched,
 * so a caller below Maintainer saw every lane's tag — which is the language
 * name — along with that lane's built-in check overrides and its rule text:
 *
 *   * `algorithmicChecksByLane`, keyed by lane tag (`''` = the default lane);
 *   * `rules`, where a rule with `scope: "lane"` names its lane in `lane`
 *     (absent `lane` is the default lane, as `ruleAppliesToLane` reads it).
 *
 * A tag is visible only when a GRANTED target lane carries it — the same
 * predicate the derived `builtinChecksByLane` field already applies
 * (sync-worker/src/external/effective-checks.ts), so the raw blob and the
 * resolved view beside it now agree. A tag no current lane carries is hidden
 * too: a stale tag is still a language name.
 *
 * The write side is the AQU-1750 restore. A caller below the settings write
 * floor echoes its filtered read back, so the entries it never saw are put
 * back before the route diffs the blob. Without that the echo reads as a
 * deletion of every hidden lane's overrides and rules, and a project lead's
 * one-key carve-out save — the Autopilot toggle, say — is refused as a
 * `rules` write it never made.
 */

import type { LaneIdentity } from "./read-wall"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether the caller may see this lane tag. `visible === null` is every lane.
 * A tag is shown only when some granted target lane carries it, so a tag that
 * matches no current lane is hidden rather than echoed back.
 */
export function laneTagVisible(
  tag: string,
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): boolean {
  if (visible === null) return true
  return lanes.some((lane) => (lane.legacyTag ?? "") === tag && visible.has(lane.id))
}

/** The lane tag a rule is pinned to, or null when it is not lane-scoped. */
function ruleLaneTag(rule: unknown): string | null {
  if (!isRecord(rule) || rule.scope !== "lane") return null
  const lane = rule.lane
  return typeof lane === "string" ? lane : ""
}

/** A rule is hidden only when it is pinned to a lane the caller cannot see. */
export function ruleLaneHidden(
  rule: unknown,
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): boolean {
  const tag = ruleLaneTag(rule)
  if (tag === null) return false
  return !laneTagVisible(tag, visible, lanes)
}

/** A rule's identity for the merge: its `id`, when it has a usable one. */
function ruleId(rule: unknown): string | null {
  if (!isRecord(rule)) return null
  return typeof rule.id === "string" && rule.id !== "" ? rule.id : null
}

/** The `algorithmicChecksByLane` copy a walled caller may see. Pure. */
export function filterLaneChecksToVisibleLanes(
  byLane: Record<string, unknown>,
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): Record<string, unknown> {
  if (visible === null) return byLane
  const next: Record<string, unknown> = {}
  for (const [tag, value] of Object.entries(byLane)) {
    if (!laneTagVisible(tag, visible, lanes)) continue
    next[tag] = value
  }
  return next
}

/** The `rules` array a walled caller may see: lane-scoped rules on hidden lanes go. */
export function filterRulesToVisibleLanes(
  rules: readonly unknown[],
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): unknown[] {
  if (visible === null) return [...rules]
  return rules.filter((rule) => !ruleLaneHidden(rule, visible, lanes))
}

/**
 * Put the hidden lanes' check overrides back onto a save built from a
 * filtered read. `null` means nothing was hidden, so the body stays the
 * caller's own — no key is added where the stored row has none.
 *
 * A hidden tag keeps its stored entry. A visible tag takes the incoming
 * entry, or goes when the body left it out (that deletion is the caller's to
 * make). An incoming entry naming a hidden tag is ignored, so a lane the
 * caller cannot see is never written through a tag it guessed.
 */
export function restoreHiddenLaneChecks(
  stored: Record<string, unknown>,
  incoming: unknown,
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): Record<string, unknown> | null {
  if (visible === null) return null
  if (Object.keys(stored).every((tag) => laneTagVisible(tag, visible, lanes))) return null
  const sent = isRecord(incoming) ? incoming : {}
  const next: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const [tag, value] of Object.entries(stored)) {
    seen.add(tag)
    if (!laneTagVisible(tag, visible, lanes)) {
      next[tag] = value
      continue
    }
    if (tag in sent) next[tag] = sent[tag]
  }
  for (const [tag, value] of Object.entries(sent)) {
    if (seen.has(tag) || !laneTagVisible(tag, visible, lanes)) continue
    next[tag] = value
  }
  return next
}

/**
 * Put the hidden lanes' rules back onto a save built from a filtered read.
 * `null` means no stored rule was hidden.
 *
 * A hidden rule keeps its stored place. A visible rule the body still carries
 * keeps that body's version — so a real edit stays a real edit in the
 * route's diff, rather than being silently discarded — and one the body drops
 * is deleted. A rule the body pins to a hidden lane is ignored, as is one
 * whose id a hidden stored rule already holds.
 */
export function restoreHiddenLaneRules(
  stored: readonly unknown[],
  incoming: unknown,
  visible: ReadonlySet<string> | null,
  lanes: readonly LaneIdentity[],
): unknown[] | null {
  if (visible === null) return null
  if (!stored.some((rule) => ruleLaneHidden(rule, visible, lanes))) return null
  const sent: readonly unknown[] = Array.isArray(incoming) ? incoming : []

  const sentById = new Map<string, unknown>()
  const sentLoose: unknown[] = []
  for (const rule of sent) {
    const id = ruleId(rule)
    if (id === null) sentLoose.push(rule)
    else if (!sentById.has(id)) sentById.set(id, rule)
  }

  const used = new Set<string>()
  const next: unknown[] = []
  for (const rule of stored) {
    const id = ruleId(rule)
    if (ruleLaneHidden(rule, visible, lanes)) {
      next.push(rule)
      if (id !== null) used.add(id)
      continue
    }
    if (id === null) {
      if (sentLoose.some((candidate) => sameJson(candidate, rule))) next.push(rule)
      continue
    }
    if (!sentById.has(id)) continue
    const candidate = sentById.get(id)
    if (ruleLaneHidden(candidate, visible, lanes)) continue
    next.push(sameJson(candidate, rule) ? rule : candidate)
    used.add(id)
  }
  for (const rule of sent) {
    if (ruleLaneHidden(rule, visible, lanes)) continue
    const id = ruleId(rule)
    if (id === null) {
      if (!next.some((kept) => sameJson(kept, rule))) next.push(rule)
      continue
    }
    if (used.has(id)) continue
    next.push(rule)
    used.add(id)
  }
  return next
}
