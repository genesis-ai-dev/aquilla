/**
 * AQU-2323: the person inspector's words. The No access row must count the
 * same places it lists, kind by kind; a team grant must read as the team,
 * not the organization it sits in; and the second reason line must name the
 * grant here as redundant only when the server says it adds nothing.
 */
import { describe, expect, it } from "vitest"

import { t } from "@/lib/i18n/standalone"

import { placeCountText, placePath, reasonLines } from "./person-inspector"

const org = { type: "org" as const, id: "1", name: "Biblica" }
const desk = { type: "team" as const, id: "3", name: "Review desk" }
const list = (names: string[]) => names.join(" and ")

describe("person inspector text", () => {
  it("counts each kind that has places, outermost first, with the glossary's lane wording", () => {
    expect(placeCountText(t, { org: 0, team: 1, project: 3, lane: 2 })).toBe("1 team · 3 projects · 2 language lanes")
    expect(placeCountText(t, { org: 1, team: 0, project: 1, lane: 0 })).toBe("1 organization · 1 project")
    expect(placeCountText(t, { org: 0, team: 0, project: 0, lane: 0 })).toBe("")
  })

  it("draws a team-ending path as the team, and any other path unchanged", () => {
    expect(placePath([org, desk])).toEqual([desk])
    expect(placePath([org, { type: "project", id: "r1", name: "Ruth" }])).toHaveLength(2)
    expect(placePath([org, { ...desk, name: "", hidden: true }])).toHaveLength(2)
  })

  it("names the redundant grant only when the server marks it, and hides a place the viewer cannot see", () => {
    const base = { kind: "direct" as const, via: null, alsoVia: [desk] }
    expect(reasonLines(t, { ...base, redundantDirect: true }, list)).toEqual(["Granted here", "The grant here adds nothing over Review desk"])
    expect(reasonLines(t, { ...base, redundantDirect: false }, list)).toEqual(["Granted here", "Review desk gives the same role"])
    expect(reasonLines(t, { kind: "inherited", via: { ...desk, id: "", name: "", hidden: true }, alsoVia: [], redundantDirect: false }, list))
      .toEqual(["Reaches here through a place you cannot see"])
  })
})
