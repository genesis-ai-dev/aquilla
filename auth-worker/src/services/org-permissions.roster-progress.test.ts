// AQU-485: unit tests for the roster/member-progress visibility helpers.
//
// These are pure functions (no DB) — they encode the INTENT of the gate:
// a caller strictly below the configured floor must never be treated as
// permitted, regardless of which of the two (independent) flags is checked.
// A regression here (e.g. accidentally using `>` instead of `>=`, or treating
// null role as permitted) would silently leak a sensitive team's roster or
// productivity data — that's why these are asserted directly, not just
// exercised incidentally via the route tests.

import { describe, it, expect } from "vitest"
import {
  canViewRoster,
  canViewMemberProgress,
  DEFAULT_ROSTER_VIEW_MIN_ROLE,
  DEFAULT_MEMBER_PROGRESS_VIEW_MIN_ROLE,
} from "./org-permissions"

describe("canViewRoster", () => {
  it("denies a caller below the configured floor", () => {
    // Contributor (400) must not see the roster when the org has raised the
    // floor to maintainer (600) — this is the whole point of AQU-485: a
    // sensitive team can hide who/how many are on a project from members.
    expect(canViewRoster(400, 600)).toBe(false)
  })

  it("permits a caller exactly at the floor", () => {
    expect(canViewRoster(600, 600)).toBe(true)
  })

  it("permits a caller above the floor", () => {
    expect(canViewRoster(700, 600)).toBe(true)
  })

  it("denies when the caller has no resolved role (null)", () => {
    // A null role means "we don't know this caller's role" — the safe
    // default is deny, never permit-by-default.
    expect(canViewRoster(null, DEFAULT_ROSTER_VIEW_MIN_ROLE)).toBe(false)
  })

  it("permits any member when the org sets the floor to VIEWER (100)", () => {
    // Confirms the floor is genuinely configurable in both directions, not
    // just raisable — an org can also open the roster to everyone.
    expect(canViewRoster(100, 100)).toBe(true)
  })
})

describe("canViewMemberProgress", () => {
  it("is independent of canViewRoster — denies progress while roster is allowed", () => {
    // AQU-485 acceptance criterion: roster shown while progress hidden, and
    // vice-versa. A contributor (400) allowed to see the roster (floor 100)
    // must still be denied progress when its floor is maintainer (600).
    const callerRole = 400
    expect(canViewRoster(callerRole, 100)).toBe(true)
    expect(canViewMemberProgress(callerRole, 600)).toBe(false)
  })

  it("is independent of canViewRoster — allows progress while roster is hidden", () => {
    // The inverse: a project_lead (500) denied the roster (floor 600) but
    // explicitly granted progress visibility (floor 500) sees progress.
    const callerRole = 500
    expect(canViewRoster(callerRole, 600)).toBe(false)
    expect(canViewMemberProgress(callerRole, 500)).toBe(true)
  })

  it("denies when the caller has no resolved role (null)", () => {
    expect(canViewMemberProgress(null, DEFAULT_MEMBER_PROGRESS_VIEW_MIN_ROLE)).toBe(false)
  })

  it("defaults are safe for sensitive teams (maintainer-only)", () => {
    // A contributor (400, below maintainer=600) must be denied under the
    // documented default floors, out of the box, with no org configuration.
    expect(canViewRoster(400, DEFAULT_ROSTER_VIEW_MIN_ROLE)).toBe(false)
    expect(canViewMemberProgress(400, DEFAULT_MEMBER_PROGRESS_VIEW_MIN_ROLE)).toBe(false)
  })
})
