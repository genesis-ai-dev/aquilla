// AQU-496 / AQU-581: the client-side assign-work gates.
//
// These are UX gates, not the security boundary — sync-worker's authorize()
// re-checks every `assignment.create` independently. What they must never do
// is DRIFT from it: offering an action the server will 403 is the bug this
// file guards against, so each case below has a counterpart in
// sync-worker/src/__tests__/authorize.test.ts.

import { describe, it, expect } from "vitest"
import {
  ROLE,
  canOpenAssignUi,
  canSubmitAssignment,
  laneDelegateLanes,
  type LaneDelegateGrant,
} from "./role-policy"

/** A mentor scoped to the Spanish lane, in an org that turned the grant on. */
const ES_DELEGATE: LaneDelegateGrant = {
  allowScopedLaneAssignment: true,
  scopes: [{ kind: "lane", value: "es" }],
}

/** The same person before the org opted in — scopes without the setting. */
const ES_DELEGATE_SETTING_OFF: LaneDelegateGrant = {
  ...ES_DELEGATE,
  allowScopedLaneAssignment: false,
}

/** The setting on, but this member carries no scopes at all. */
const UNSCOPED_GRANT: LaneDelegateGrant = {
  allowScopedLaneAssignment: true,
  scopes: [],
}

describe("laneDelegateLanes (AQU-581)", () => {
  it("returns the lane scope values when the org has opted in", () => {
    expect(laneDelegateLanes(ES_DELEGATE)).toEqual(["es"])
  })

  it("returns nothing while the setting is off, however many scopes the member has", () => {
    expect(laneDelegateLanes(ES_DELEGATE_SETTING_OFF)).toEqual([])
  })

  it("returns nothing for an unscoped member — the setting alone grants nothing", () => {
    expect(laneDelegateLanes(UNSCOPED_GRANT)).toEqual([])
  })

  it("ignores file scopes — the grant is lane-shaped", () => {
    expect(
      laneDelegateLanes({
        allowScopedLaneAssignment: true,
        scopes: [{ kind: "file", value: "file-x" }],
      }),
    ).toEqual([])
  })

  it("returns nothing when there is no grant at all", () => {
    expect(laneDelegateLanes(undefined)).toEqual([])
  })
})

describe("canOpenAssignUi (AQU-496 / AQU-581)", () => {
  it("opens for PROJECT_LEAD with neither carve-out", () => {
    expect(canOpenAssignUi(ROLE.PROJECT_LEAD, false)).toBe(true)
  })

  it("stays shut for a CONTRIBUTOR with neither carve-out", () => {
    expect(canOpenAssignUi(ROLE.CONTRIBUTOR, false)).toBe(false)
  })

  it("opens for a lane delegate below lead, with self-assignment OFF", () => {
    expect(canOpenAssignUi(ROLE.CONTRIBUTOR, false, ES_DELEGATE)).toBe(true)
  })

  it("stays shut for a scoped member while the org setting is off", () => {
    expect(canOpenAssignUi(ROLE.CONTRIBUTOR, false, ES_DELEGATE_SETTING_OFF)).toBe(false)
  })

  it("stays shut for an unscoped member even with the setting on", () => {
    expect(canOpenAssignUi(ROLE.CONTRIBUTOR, false, UNSCOPED_GRANT)).toBe(false)
  })

  it("stays shut for a lane-scoped REVIEWER — the delegate floor is CONTRIBUTOR", () => {
    expect(canOpenAssignUi(ROLE.REVIEWER, false, ES_DELEGATE)).toBe(false)
  })
})

describe("canSubmitAssignment (AQU-496 / AQU-581)", () => {
  const CALLER = 7
  const SOMEONE_ELSE = 99

  it("lets a lead assign anyone in any lane", () => {
    expect(canSubmitAssignment(ROLE.PROJECT_LEAD, false, CALLER, SOMEONE_ELSE, undefined, "fr")).toBe(true)
  })

  it("lets a lane delegate assign ANOTHER person inside a scoped lane", () => {
    expect(canSubmitAssignment(ROLE.CONTRIBUTOR, false, CALLER, SOMEONE_ELSE, ES_DELEGATE, "es")).toBe(true)
  })

  it("refuses that delegate in a lane they are not scoped to", () => {
    expect(canSubmitAssignment(ROLE.CONTRIBUTOR, false, CALLER, SOMEONE_ELSE, ES_DELEGATE, "fr")).toBe(false)
  })

  it("refuses that delegate in the default lane — an omitted lane is not a wildcard", () => {
    expect(canSubmitAssignment(ROLE.CONTRIBUTOR, false, CALLER, SOMEONE_ELSE, ES_DELEGATE)).toBe(false)
  })

  it("still refuses a below-lead member with no grant assigning someone else", () => {
    expect(canSubmitAssignment(ROLE.CONTRIBUTOR, true, CALLER, SOMEONE_ELSE)).toBe(false)
  })

  it("keeps the AQU-496 self-assign path working alongside the delegate path", () => {
    expect(canSubmitAssignment(ROLE.CONTRIBUTOR, true, CALLER, CALLER)).toBe(true)
  })

  it("lets a delegate self-assign in their own lane even with self-assignment off", () => {
    expect(canSubmitAssignment(ROLE.CONTRIBUTOR, false, CALLER, CALLER, ES_DELEGATE, "es")).toBe(true)
  })

  it("refuses a lane-scoped REVIEWER — the delegate floor is CONTRIBUTOR", () => {
    expect(canSubmitAssignment(ROLE.REVIEWER, false, CALLER, SOMEONE_ELSE, ES_DELEGATE, "es")).toBe(false)
  })
})
