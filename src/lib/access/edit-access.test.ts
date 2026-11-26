/**
 * AQU-2321: a Places-lens row maps to the grant (or invite) the Remove dialog
 * names. An invite drawn on a lane is a project invite, cancelled by whoever
 * may invite to that project; mapping it to the lane would ask the server
 * about the wrong place and refuse a cancel the viewer is allowed to make.
 */
import { describe, expect, it } from "vitest"

import { inviteRowId, rowEdit, rowGrant, rowRemoval, shortList } from "./edit-access"
import type { PlaceGrantability } from "./grant-rules"

const org = { type: "org" as const, id: "1", name: "Org" }
const project = { type: "project" as const, id: "p1", name: "P" }
const lane = { type: "lane" as const, id: "fr", name: "French" }
const leadOnP1: Record<string, PlaceGrantability> = { "project:p1": { ok: true, cap: 500 }, "lane:fr": { ok: true, cap: 500 }, "org:1": { ok: false, denial: "owner_only" } }

describe("edit-access", () => {
  it("names an invite row by its People-lens id", () => {
    expect(inviteRowId(org, [org], "invite:tok")).toBe("invite:org:tok")
    expect(inviteRowId(lane, [org, project, lane], "invite:tok")).toBe("invite:project:p1:tok")
    expect(inviteRowId(project, [org, project], "42")).toBeNull()
  })

  it("lets a Project lead cancel a lane invite (a project invite) and remove a lane grant (AQU-2322)", () => {
    expect(rowRemoval(lane, [org, project, lane], { userId: "invite:tok", roleLevel: 300, source: "invite" }, leadOnP1, false)).toEqual({ ok: true })
    expect(rowRemoval(lane, [org, project, lane], { userId: "6", roleLevel: 300, source: "direct" }, leadOnP1, false)).toEqual({ ok: true })
    expect(rowGrant(lane)).toEqual({ type: "lane", id: "fr" })
  })

  it("never edits a creator row or an invite's role", () => {
    expect(rowEdit(project, { userId: "1", roleLevel: 700, source: "creator" }, leadOnP1, false)).toEqual({ ok: false, reason: "creator", cap: null })
    expect(rowRemoval(project, [org, project], { userId: "1", roleLevel: 700, source: "creator" }, leadOnP1, false)).toEqual({ ok: false, reason: "creator", cap: null })
    expect(rowEdit(project, { userId: "invite:t", roleLevel: 300, source: "invite" }, leadOnP1, false)).toEqual({ ok: false, reason: "invite", cap: null })
  })

  it("shortens a list to two names and a count, but never to 'and 1 more'", () => {
    expect(shortList(["A", "B", "C", "D", "E"])).toEqual({ shown: ["A", "B"], more: 3 })
    expect(shortList(["A", "B", "C"])).toEqual({ shown: ["A", "B", "C"], more: 0 })
  })
})
