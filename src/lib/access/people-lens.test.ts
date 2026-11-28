/**
 * AQU-2319: who is on the People lens, what their highest role and reach are,
 * and which filter chip they belong on. The page and the CSV both call these.
 */
import { describe, expect, it } from "vitest"

import { formatScopePath } from "@/lib/access/scope-path"
import type { AccessChainEntry, ScopePath } from "@/lib/access/types"
import { t } from "@/lib/i18n/standalone"

import {
  INACTIVE_AFTER_MS,
  canGiveAccess,
  countPlaces,
  formatReach,
  grantedAtPlaces,
  highestRoleLevel,
  matchesPeopleFilter,
  personReach,
  selectRoster,
  type PeopleFilter,
  type RosterPerson,
} from "./people-lens"

const NOW = Date.parse("2026-06-01T00:00:00.000Z")
const org = { type: "org" as const, id: "1", name: "Biblica" }
const project = { type: "project" as const, id: "p1", name: "Pattani" }
const other = { type: "project" as const, id: "p2", name: "Other" }
const french = { type: "lane" as const, id: "fr", name: "French" }
const hiddenOrg = { type: "org" as const, id: "1", name: "", hidden: true as const }

function grant(path: ScopePath, roleLevel: number, kind: AccessChainEntry["origin"]["kind"] = "direct"): AccessChainEntry {
  return { scopePath: path, roleLevel, origin: kind === "inherited" ? { kind, from: path } : { kind } }
}

function person(patch: Partial<RosterPerson> & Pick<RosterPerson, "userId" | "displayName">): RosterPerson {
  return { isGuest: false, grants: [], ...patch }
}

const counts = { teams: 2, projects: 10 }

describe("People lens roster", () => {
  it("filters members, guests, invites, granters, and people inactive for 90 days", () => {
    const recent = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString()
    const stale = new Date(NOW - INACTIVE_AFTER_MS - 1000).toISOString()
    const people: RosterPerson[] = [
      person({ userId: "guest", displayName: "Naladda", isGuest: true, lastActiveAt: recent, grants: [grant([org, project], 300)] }),
      person({ userId: "member", displayName: "Bare", lastActiveAt: null, grants: [grant([org], 100)] }),
      person({
        userId: "invite:1",
        displayName: "soon@example.com",
        pendingInvite: { expiresAt: null, roleLevel: 300 },
        grants: [grant([org, project], 300)],
      }),
      person({ userId: "keeper", displayName: "Keeper", lastActiveAt: recent, grants: [grant([org, project], 600)] }),
      person({ userId: "stale", displayName: "Stale", lastActiveAt: stale, grants: [grant([org, project], 400)] }),
      person({ userId: "owner", displayName: "Ruth", lastActiveAt: recent, grants: [grant([org], 700)] }),
    ]
    const expectNames = (filter: PeopleFilter, names: string[]) => {
      expect(selectRoster(people, { query: "", filter, now: NOW }).map((row) => row.displayName).sort()).toEqual(names)
    }
    expectNames("everyone", ["Bare", "Keeper", "Naladda", "Ruth", "Stale", "soon@example.com"])
    expectNames("members", ["Bare", "Keeper", "Ruth", "Stale"])
    expectNames("guests", ["Naladda"])
    expectNames("invites", ["soon@example.com"])
    expectNames("granters", ["Keeper", "Ruth"])
    expectNames("inactive", ["Bare", "Stale"])
    expect(selectRoster(people, { query: "naladda@example.com", filter: "everyone", now: NOW })).toEqual([])
    expect(selectRoster(people, { query: "Naladda", filter: "guests", now: NOW }).map((row) => row.userId)).toEqual(["guest"])
    expect(matchesPeopleFilter(people[2]!, "granters", NOW)).toBe(false)
    expect(canGiveAccess(people[3]!)).toBe(true)
    expect(canGiveAccess(people[0]!)).toBe(false)
  })

  it("states the highest opening role and how far that person reaches", () => {
    const cases: { name: string; person: RosterPerson; reach: string; role: number | null }[] = [
      {
        name: "org owner",
        person: person({ userId: "1", displayName: "Ruth", grants: [grant([org], 700)] }),
        reach: "Everything · 2 teams, 10 projects",
        role: 700,
      },
      {
        name: "bare member",
        person: person({ userId: "2", displayName: "Bare", grants: [grant([org], 100)] }),
        reach: "Nothing. Org membership alone opens no project.",
        role: null,
      },
      {
        name: "org project lead opens nothing",
        person: person({ userId: "3", displayName: "Lead", grants: [grant([org], 500)] }),
        reach: "Nothing. Org membership alone opens no project.",
        role: null,
      },
      {
        name: "guest on one project",
        person: person({ userId: "4", displayName: "Naladda", isGuest: true, grants: [grant([org, project], 300)] }),
        reach: "1 project",
        role: 300,
      },
      {
        name: "two projects",
        person: person({
          userId: "5",
          displayName: "Two",
          grants: [grant([org, project], 300), grant([org, other], 400)],
        }),
        reach: "2 projects",
        role: 400,
      },
      {
        name: "language lane only",
        person: person({ userId: "6", displayName: "Lane", grants: [grant([org, project, french], 200)] }),
        reach: "1 language lane",
        role: 200,
      },
      {
        name: "org membership plus a project",
        person: person({ userId: "7", displayName: "Both", grants: [grant([org], 100), grant([org, project], 300)] }),
        reach: "1 project",
        role: 300,
      },
      {
        name: "invited role",
        person: person({
          userId: "invite:1",
          displayName: "soon@example.com",
          pendingInvite: { expiresAt: null, roleLevel: 300 },
          grants: [grant([org, project], 300)],
        }),
        reach: "1 project",
        role: 300,
      },
      {
        name: "hidden organization does not count as everything",
        person: person({ userId: "8", displayName: "Walled", grants: [grant([hiddenOrg, project], 700)] }),
        reach: "1 project",
        role: 700,
      },
    ]
    for (const row of cases) {
      expect(formatReach(t, personReach(row.person, counts)), row.name).toBe(row.reach)
      expect(highestRoleLevel(row.person), row.name).toBe(row.role)
    }
    expect(countPlaces([
      { scope: { type: "org", id: "1" }, children: [
        { scope: { type: "team", id: "t" }, children: [{ scope: { type: "project", id: "p1" } }] },
        { scope: { type: "project", id: "p2" } },
      ] },
    ])).toEqual({ teams: 1, projects: 2 })
  })

  it("shows two direct-grant breadcrumbs and counts the rest", () => {
    const row = person({
      userId: "1",
      displayName: "Many",
      grants: [
        grant([org, other], 300),
        grant([org, project], 300),
        grant([org], 100),
        grant([org, project, french], 200, "inherited"),
      ],
    })
    const places = grantedAtPlaces(row)
    expect(places.shown.map((path) => formatScopePath(path))).toEqual(["Biblica", "Biblica › Other"])
    expect(places.extra).toBe(1)
  })
})

describe("AQU-2322: a lane grant on the roster", () => {
  // The payload draws a project row that only carries lane grants as those
  // lanes (auth-worker lane-shape.ts), so the Reaches cell reads them as lanes.
  it("someone whose only access is one lane grant reaches 1 lane, not a project", () => {
    const lucia = person({ userId: "12", displayName: "Lucía", isGuest: true, grants: [grant([org, project, french], 400)] })
    expect(personReach(lucia, counts)).toEqual({ kind: "lanes", count: 1 })
    expect(formatReach(t, personReach(lucia, counts))).toBe("1 language lane")
    // An organization role that opens nothing does not change that.
    const member = person({ userId: "4", displayName: "Ana", grants: [grant([org], 400), grant([org, project, french], 400)] })
    expect(personReach(member, counts)).toEqual({ kind: "lanes", count: 1 })
  })
})
