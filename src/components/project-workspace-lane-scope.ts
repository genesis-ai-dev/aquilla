// AQU-1029: which lane a lane-scoped member should LAND on when they open a
// project.
//
// `activeLane` (AQU-538) is seeded from a per-project localStorage key, which
// is empty the first time anyone opens a project — so it falls back to `''`,
// the Project default lane. For a member whose write scope (AQU-553) is a
// single non-default target lane that is the wrong place to land: the default
// lane shows a language they cannot write to, and the only route to their own
// lane is via "assignment" and a click-in. Partner report (Global Publishing,
// 2026-08-26): "opening the project lands you on the default/root project
// rather than the lane you're assigned to".
//
// The rule below is the missing seed. It is deliberately narrow — it only ever
// supplies an OPENING lane when nothing else has an opinion:
//
// - a `?lane=` deep link wins (it is an explicit instruction — see
//   `project-workspace-lane-deeplink.ts`),
// - a persisted lane wins (the member already chose one on this project),
// - and once the seed has run for a project it never runs again, so a member
//   who switches back to Project default stays there on the next visit.
//
// Those guards live in ProjectWorkspace (they need storage + the router); this
// module is the pure "given these scopes and these lanes, which lane?" rule so
// it can be unit-tested without a harness, mirroring the two sibling helpers.

import { languagesEqual } from "@/lib/language-normalize"
import type { MemberScope } from "@/lib/sync/member-scopes"

/**
 * The lane a member's own scopes say they should open a project on, or `null`
 * for "no opinion — leave the default lane alone".
 *
 * Returns `null` when:
 * - the member has no lane scopes (unscoped, or scopes not loaded yet — the
 *   caller cannot tell the two apart, and both mean "don't move them"),
 * - the member IS scoped to the default lane (`''`), which is where they
 *   already land, or
 * - none of their lane scopes is an offered lane — including the AQU-1240
 *   case where the scope names the project's primary target language, which
 *   `availableLanes` deliberately drops because the default lane already IS
 *   that language.
 *
 * Otherwise returns the first offered lane matching one of their lane scopes,
 * using the offered lane's own tag so `activeLane` is always a real lane.
 * Matching is `languagesEqual` rather than `===` so a scope written as `es-ES`
 * or `spa` still finds the `es` lane.
 *
 * `availableLanes` is ProjectWorkspace's `["", ...targetLanes]` (primary
 * filtered out), so `''` is expected as its first entry.
 */
export function resolveScopedLandingLane(
  scopes: readonly MemberScope[] | null | undefined,
  availableLanes: readonly string[],
): string | null {
  if (!scopes || scopes.length === 0) return null
  const laneScopes = scopes.filter((s) => s.kind === "lane")
  if (laneScopes.length === 0) return null
  // Scoped to the default lane → they already land there; don't move them.
  if (laneScopes.some((s) => s.value === "")) return null
  for (const scope of laneScopes) {
    const match = availableLanes.find((lane) => lane !== "" && languagesEqual(lane, scope.value))
    if (match) return match
  }
  return null
}

/** What the workspace should do about the opening lane on this render. */
export type ScopedLandingLaneDecision =
  /** Inputs aren't settled yet (project or scopes still loading) — try again. */
  | { action: "wait" }
  /** Someone else owns the lane (deep link / prior choice) — stand down for good. */
  | { action: "stand-down" }
  /**
   * The seed has had its one chance: record that it ran, and move to `lane`
   * when it is non-null. `null` means the member's scopes had no opinion —
   * still one-shot, so an unscoped member who is scoped LATER isn't yanked off
   * a lane they have since settled on.
   */
  | { action: "seed"; lane: string | null }

/**
 * AQU-1029: the precedence chain in front of {@link resolveScopedLandingLane}.
 *
 * The seed is strictly the last voice in the room, and the order matters:
 *
 * 1. `?lane=` — an explicit instruction from the link that opened the editor.
 * 2. A persisted lane — the member already chose one on this project.
 * 3. `alreadySeeded` — the seed ran before. This flag is load-bearing: the lane
 *    key stores Project default as an ABSENT key, so without it "never opened"
 *    and "opened and deliberately switched back to default" are the same
 *    reading and the seed would drag the member off default on every reload.
 * 4. Otherwise seed, once the project (lane registry) and scopes have loaded.
 *
 * Kept pure — storage and the router live in ProjectWorkspace — so the
 * precedence itself is pinned by tests rather than only by reading the effect.
 */
export function decideScopedLandingLane(input: {
  /** `searchParams.has("lane")` — an explicit deep link, empty value included. */
  hasLaneParam: boolean
  /** `readPersistedActiveLane(projectId)`; `''` when nothing is stored. */
  persistedLane: string
  /** `hasSeededActiveLane(projectId)`. */
  alreadySeeded: boolean
  /** False until `useProject` resolves, so `availableLanes` can be trusted. */
  projectLoaded: boolean
  /** `useMyScopes` — `[]` both while loading and for an unscoped member. */
  scopes: readonly MemberScope[] | null | undefined
  availableLanes: readonly string[]
}): ScopedLandingLaneDecision {
  if (input.hasLaneParam) return { action: "stand-down" }
  if (input.persistedLane || input.alreadySeeded) return { action: "stand-down" }
  // `scopes: []` is indistinguishable from "not loaded yet". Both mean "don't
  // move them", so waiting is free for an unscoped member and correct for one
  // whose fetch is still in flight.
  if (!input.projectLoaded || !input.scopes || input.scopes.length === 0) return { action: "wait" }
  return { action: "seed", lane: resolveScopedLandingLane(input.scopes, input.availableLanes) }
}
