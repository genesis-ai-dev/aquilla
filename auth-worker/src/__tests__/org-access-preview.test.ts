/**
 * AQU-2320 — POST /api/v2/orgs/:orgId/access/preview, the Give access dry run.
 *
 * The dialog's primary button waits on this answer, and its "What changes"
 * panel is only this answer drawn. So it has to (1) say what the resolver
 * would actually do — a redundant grant must read as redundant, a raise as a
 * raise — and (2) refuse every grant the write route would refuse, naming
 * the place, the role and the cap, so the denial explains itself.
 *
 * Fixture (helpers/access-fixture.ts): team 1 "fixture/translators" opens
 * p1, p2 at Contributor; team 2 "fixture/leads" opens p3 at Owner.
 */
import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor } from "./helpers/db"
import { FIXTURE_ORG_ID, FIXTURE_USERS, seedAccessFixture, type FixtureUser } from "./helpers/access-fixture"

interface Effective { roleLevel: number; source: string; via: { type: string; id: string; name: string } }
interface Preview {
  placePath: { type: string; name: string }[]
  here: { before: Effective | null; after: Effective | null }
  replaces: number | null
  changes: { project: { id: string }; before: Effective | null; after: Effective | null }[]
  redundant: boolean
  guest: { before: boolean; after: boolean }
  includesFutureProjects: boolean
  invite: boolean
}

type Person = { userId: string } | { email: string }
const person = (who: FixtureUser): Person => ({ userId: String(FIXTURE_USERS[who]) })

async function preview(viewer: FixtureUser, body: { place: { type: string; id: string }; roleLevel: number; person: Person }) {
  const res = await app.request(
    `/api/v2/orgs/${FIXTURE_ORG_ID}/access/preview`,
    { method: "POST", headers: { ...authHeader(await jwtFor(viewer)), "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  )
  return { status: res.status, body: (await res.json()) as { preview?: Preview; error?: string; code?: string; cap?: number | null } }
}

const levels = (p: Preview) => Object.fromEntries(p.changes.map((c) => [c.project.id, [c.before?.roleLevel ?? null, c.after?.roleLevel ?? null]]))

beforeEach(async () => {
  await seedAccessFixture()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, position) VALUES
       ('lanefr01', 'p1', 'target', 'French', 'French', 0)`,
  ).run()
})

describe("AQU-2320 Give access dry run", () => {
  it("names a grant that adds nothing, then the write leaves the inherited team row beside the new direct row", async () => {
    // team_only reaches p2 as Reviewer through fixture/translators.
    await env.AQUILLA_PG.prepare("UPDATE group_project_grants SET role_level = 300 WHERE group_id = 1 AND project_id = 'p2'").run()
    const { status, body } = await preview("owner", { place: { type: "project", id: "p2" }, roleLevel: 300, person: person("team_only") })
    expect(status).toBe(200)
    expect(body.preview?.redundant).toBe(true)
    expect(body.preview?.changes).toEqual([])
    expect(body.preview?.here.before).toMatchObject({ roleLevel: 300, source: "team", via: { type: "team", name: "fixture/translators" } })

    // Submitting goes through the existing project-member route, unchanged.
    const write = await app.request(
      "/api/v2/projects/p2/members",
      {
        method: "POST",
        headers: { ...authHeader(await jwtFor("owner")), "Content-Type": "application/json" },
        body: JSON.stringify({ username: "team_only", role: 300, allCurrentLanes: true }),
      },
      env,
    )
    expect(write.status).toBe(200)
    const access = (await (await app.request(`/api/v2/orgs/${FIXTURE_ORG_ID}/access`, { headers: authHeader(await jwtFor("owner")) }, env)).json()) as {
      tree: { scope: { type: string; id: string }; children: unknown[]; directGrantees: { displayName: string; roleLevel: number }[]; inherited: { kind: string; from: { name: string }; roleLevel: number }[] }[]
    }
    type N = (typeof access.tree)[number]
    const flat = (n: N): N[] => [n, ...(n.children as N[]).flatMap(flat)]
    const p2 = access.tree.flatMap(flat).find((n) => n.scope.type === "project" && n.scope.id === "p2")
    expect(p2?.directGrantees).toContainEqual(expect.objectContaining({ displayName: "team_only", roleLevel: 300 }))
    expect(p2?.inherited).toContainEqual(expect.objectContaining({ kind: "team", roleLevel: 300, from: expect.objectContaining({ name: "fixture/translators" }) }))
  })

  it("reports a raise on every project a team-scope role lifts", async () => {
    // team_only already sits on fixture/translators at Contributor (via p1, p2).
    const { body } = await preview("owner", { place: { type: "team", id: "1" }, roleLevel: 600, person: person("team_only") })
    expect(levels(body.preview as Preview)).toEqual({ p1: [400, 600], p2: [400, 600] })
    expect(body.preview?.redundant).toBe(false)
    expect(body.preview?.includesFutureProjects).toBe(true)
  })

  it("a team grant to someone with no org row keeps them a Guest and opens the team's projects", async () => {
    // external: no org_members row, direct Reviewer on p2.
    const { body } = await preview("owner", { place: { type: "team", id: "1" }, roleLevel: 600, person: person("external") })
    expect(body.preview?.guest).toEqual({ before: true, after: true })
    expect(levels(body.preview as Preview)).toEqual({ p1: [null, 600], p2: [300, 600] })
  })

  it("an org grant ends Guest status; an org invite does too", async () => {
    const account = await preview("owner", { place: { type: "org", id: "1" }, roleLevel: 600, person: person("external") })
    expect(account.body.preview?.guest).toEqual({ before: true, after: false })
    const invite = await preview("owner", { place: { type: "org", id: "1" }, roleLevel: 600, person: { email: "New@Example.com" } })
    expect(invite.body.preview).toMatchObject({ invite: true, guest: { before: true, after: false } })
  })

  it("a lowered direct row is not called redundant even when another path keeps the level", async () => {
    // direct_below: direct Reviewer on p1, team Contributor. Re-granting Viewer replaces the direct row.
    const { body } = await preview("owner", { place: { type: "project", id: "p1" }, roleLevel: 100, person: person("direct_below") })
    expect(body.preview?.replaces).toBe(300)
    expect(body.preview?.changes).toEqual([])
    expect(body.preview?.redundant).toBe(false)
  })

  it("a lane grant opens one lane for someone not yet on the project, and refuses to narrow someone already there", async () => {
    const fresh = await preview("owner", { place: { type: "lane", id: "lanefr01" }, roleLevel: 400, person: person("org_contrib") })
    expect(fresh.status).toBe(200)
    expect(fresh.body.preview?.placePath.map((s) => s.name)).toEqual(["Fixture Org", "Alpha", "French"])
    expect(fresh.body.preview?.here.after).toMatchObject({ roleLevel: 400, source: "lane" })

    const onProject = await preview("owner", { place: { type: "lane", id: "lanefr01" }, roleLevel: 300, person: person("team_only") })
    expect(onProject.status).toBe(409)
    expect(onProject.body.code).toBe("lane_needs_staffing")
  })

  it.each<[string, FixtureUser, { type: string; id: string }, number, Person, number, string, RegExp]>([
    ["only an Owner grants at the org", "maintainer", { type: "org", id: "1" }, 600, person("org_contrib"), 403, "owner_only", /Maintainer at org "Fixture Org".*your role there: Maintainer/],
    // team_only sees its own team (org role Reviewer, below the roster floor).
    ["a team needs an org Maintainer", "team_only", { type: "team", id: "1" }, 100, person("direct_below"), 403, "maintainer_only", /Viewer at team "fixture\/translators".*your role there: Reviewer/],
    ["a team holding Owner on a project is closed to a Maintainer", "maintainer", { type: "team", id: "2" }, 100, person("org_contrib"), 403, "team_above_you", /team "fixture\/leads"/],
    ["a project offers no Maintainer", "owner", { type: "project", id: "p1" }, 600, person("org_contrib"), 400, "role_not_offered", /Maintainer at project "Alpha".*Project lead, Contributor/],
    ["a lane offers no Project lead", "owner", { type: "lane", id: "lanefr01" }, 500, person("org_contrib"), 400, "role_not_offered", /lane "French"/],
    ["Owner is never handed over by an invite", "owner", { type: "org", id: "1" }, 700, { email: "x@example.com" }, 403, "above_invite_cap", /Owner at org.*at most Maintainer/],
    ["a team has no invitation", "owner", { type: "team", id: "1" }, 100, { email: "x@example.com" }, 409, "no_team_invite", /team "fixture\/translators"/],
    ["nobody changes their own access here", "direct_above", { type: "project", id: "p1" }, 300, person("direct_above"), 409, "self_grant", /own access/],
  ])("refuses: %s", async (_why, viewer, place, roleLevel, who, status, code, message) => {
    const { status: got, body } = await preview(viewer, { place, roleLevel, person: who })
    expect(got).toBe(status)
    expect(body.code).toBe(code)
    expect(body.error).toMatch(message)
  })

  it("a project lead's project cap stops them at a member who outranks them", async () => {
    // org_lead and org_contrib both hold Project lead directly on p3. The route
    // (AQU-285) refuses a non-Owner changing a member at or above their own level.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p3', 3, 500, 1), ('p3', 4, 500, 1)",
    ).run()
    const { status, body } = await preview("org_lead", { place: { type: "project", id: "p3" }, roleLevel: 300, person: person("org_contrib") })
    expect(status).toBe(403)
    expect(body.code).toBe("target_outranks")
    expect(body.cap).toBe(500)
  })

  it("does not answer about a place or a person outside what this viewer's lenses show", async () => {
    // direct_above sees only fixture/translators › p1.
    const hidden = await preview("direct_above", { place: { type: "project", id: "p2" }, roleLevel: 100, person: person("team_only") })
    expect(hidden.status).toBe(404)
    // personal belongs to another org entirely.
    const stranger = await preview("owner", { place: { type: "project", id: "p1" }, roleLevel: 100, person: person("personal") })
    expect(stranger.status).toBe(404)
  })
})
