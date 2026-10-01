// AQU-1352 §3.7: roster rows must say where access comes from (rule 1) and
// the remove dialog must know what survives a direct-grant removal (rule 4).
import { describe, expect, it } from "vitest"
import type { AccessGrant } from "../../../db/shared/access-grants"
import { rosterOriginFor, type RosterContext } from "../services/roster-origins"

const ctx: RosterContext = {
  projectId: "p1",
  orgId: "9",
  orgName: "Acme",
  attachedTeamIds: ["5"],
  teamNames: new Map([["5", "BSB"]]),
}
const g = (over: Partial<AccessGrant>): AccessGrant => ({
  userId: "1", scopeType: "project", scopeId: "p1", roleLevel: 400, source: "direct",
  viaTeamId: null, grantedBy: null, grantedAt: null, ...over,
})

describe("rosterOriginFor", () => {
  it("names the team path when a team grant wins, so the row can say 'via team BSB'", () => {
    const o = rosterOriginFor([g({ roleLevel: 300 }), g({ source: "team", roleLevel: 500, viaTeamId: "5" })], ctx)
    expect(o?.effective).toEqual({ roleLevel: 500, source: "group" })
    expect(o?.direct).toBe(300)
    expect(o?.inheritedFrom).toEqual([
      { type: "org", id: "9", name: "Acme" },
      { type: "team", id: "5", name: "BSB" },
    ])
  })

  it("rule 4 dry-run: removing the direct grant leaves the team role, not nothing", () => {
    const o = rosterOriginFor([g({ roleLevel: 600 }), g({ source: "team", roleLevel: 500, viaTeamId: "5" })], ctx)
    expect(o?.inheritedFrom).toBeNull()
    expect(o?.afterDirectRemoval).toMatchObject({ roleLevel: 500, source: "group" })
    expect(o?.afterDirectRemoval?.from?.at(-1)?.name).toBe("BSB")
  })

  it("rule 4 dry-run: a direct-only member loses access entirely (null)", () => {
    expect(rosterOriginFor([g({})], ctx)?.afterDirectRemoval).toBeNull()
  })

  it("an org maintainer reaches the project through the org path", () => {
    const o = rosterOriginFor([g({ scopeType: "org", scopeId: "9", roleLevel: 600 })], ctx)
    expect(o?.effective.source).toBe("org")
    expect(o?.inheritedFrom).toEqual([{ type: "org", id: "9", name: "Acme" }])
    expect(o?.direct).toBeNull()
  })
})
