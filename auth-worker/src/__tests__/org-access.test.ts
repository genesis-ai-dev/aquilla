/**
 * AQU-1352 §3.6 (AQU-1072) — GET /api/v2/orgs/:orgId/access, the People &
 * access page. An Owner sees the whole org. AQU-2318: a project lead who can
 * see only their own team receives that team's subtree, and the payload omits
 * the org and every sibling team. Each place also carries the ancestor grants
 * that resolve there; the Places lens counts those rows.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { placeRowCounts } from "../../../src/lib/access/place-lens"
import app from "../index"
import { authHeader, jwtFor } from "./helpers/db"
import { FIXTURE_ORG_ID, seedAccessFixture, type FixtureUser } from "./helpers/access-fixture"

interface Inherited {
  kind: "person" | "team"
  roleLevel: number
  from: { type: string; id: string; name: string }
  displayName?: string
  memberCount?: number
  isGuest?: boolean
}
interface Grantee {
  displayName: string
  roleLevel: number
  isGuest?: boolean
  email?: string | null
  source?: string
  pendingInvite?: { expiresAt: string | null }
}
interface Node {
  scope: { type: string; id: string; name: string }
  children: Node[]
  directGrantees: Grantee[]
  inherited: Inherited[]
}
interface Payload {
  tree: Node[]
  people: {
    userId: string
    displayName: string
    email: string | null
    isGuest: boolean
    lastActiveAt: string | null
    pendingInvite?: { expiresAt: string | null; roleLevel: number }
    grants: { roleLevel: number; scopePath: { type?: string; id: string; name?: string }[] }[]
  }[]
}

async function orgAccess(viewer: FixtureUser, orgId = FIXTURE_ORG_ID): Promise<Response> {
  return app.request(`/api/v2/orgs/${orgId}/access`, { headers: authHeader(await jwtFor(viewer)) }, env)
}

const flatten = (n: Node): Node[] => [n, ...n.children.flatMap(flatten)]
const projectIds = (p: Payload) =>
  [...new Set(p.tree.flatMap(flatten).filter((n) => n.scope.type === "project").map((n) => n.scope.id))].sort()
const findPlace = (p: Payload, type: string, id: string) =>
  p.tree.flatMap(flatten).find((n) => n.scope.type === type && n.scope.id === id)

beforeEach(async () => {
  await seedAccessFixture()
})

describe("AQU-1352 §3.6 org People & access", () => {
  it("owner sees every team and live project, and every person", async () => {
    await env.AQUILLA_PG.prepare(
      "UPDATE org_members SET last_active_at = ? WHERE org_id = 1 AND user_id = 1",
    ).bind("2026-03-01T00:00:00.000Z").run()
    const res = await orgAccess("owner")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Payload
    expect(body.tree[0].scope.type).toBe("org")
    // Archived projects are not part of the live access picture.
    expect(projectIds(body)).toEqual(["p1", "p2", "p3"])
    expect(body.tree[0].children.filter((n) => n.scope.type === "team").map((n) => n.scope.name).sort())
      .toEqual(["fixture/leads", "fixture/translators"])
    const names = body.people.map((p) => p.displayName)
    expect(names).toContain("external")
    // Rule 5: external holds only a project row → guest.
    const guest = body.people.find((p) => p.displayName === "external")
    expect(guest?.isGuest).toBe(true)
    expect(guest?.email).toBe("external@example.com")
    expect(guest?.lastActiveAt).toBeNull()
    const owner = body.people.find((p) => p.displayName === "owner")
    expect(owner?.isGuest).toBe(false)
    expect(owner?.email).toBe("owner@example.com")
    expect(new Date(owner?.lastActiveAt ?? "").toISOString()).toContain("2026-03-01")
  })

  it("a project lead who can see only their own team gets that subtree and nothing above or beside it", async () => {
    // direct_above: 600 on p1, 400 on p2 via team, org 300 (below the roster floor).
    // Member of fixture/translators (p1, p2), not of fixture/leads.
    const res = await orgAccess("direct_above")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Payload
    expect(projectIds(body)).toEqual(["p1"])
    expect(body.tree.map((n) => n.scope.type)).toEqual(["team"])
    expect(body.tree[0].scope.name).toBe("fixture/translators")
    expect(body.tree[0].children.map((n) => n.scope.id)).toEqual(["p1"])
    const text = JSON.stringify(body)
    expect(text).not.toContain("Fixture Org")
    expect(text).not.toContain("fixture/leads")
    expect(text).not.toContain('"p2"')
    expect(text).not.toContain('"p3"')
    // external is only on p2; tim only reaches p3 — neither name ships.
    expect(text).not.toContain('"external"')
    expect(text).not.toContain('"tim"')
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at) VALUES
         ('inv-p1', 'p1', 300, 1, 'soon@example.com', now() + interval '3 days'),
         ('inv-p2', 'p2', 300, 1, 'hidden-guest@example.com', now() + interval '3 days')`,
    ).run()
    const walled = (await (await orgAccess("direct_above")).json()) as Payload
    const walledText = JSON.stringify(walled)
    const walledNames = walled.people.map((p) => p.displayName)
    expect(walled.people.some((p) => p.email === "soon@example.com")).toBe(true)
    expect(walledText).not.toContain("hidden-guest@example.com")
    expect(walledText).not.toContain('"external"')
    expect(walledNames).not.toContain("tim")
    expect(walledNames).not.toContain("org_lead")
    expect(walledNames).not.toContain("org_contrib")
    expect(walledNames).toContain("direct_below")
    const ownerBody = (await (await orgAccess("owner")).json()) as Payload
    const ownerText = JSON.stringify(ownerBody)
    expect(ownerText).toContain("soon@example.com")
    expect(ownerText).toContain("hidden-guest@example.com")
  })

  it("lists a person once per node even when they hold two grants there (creator + direct row)", async () => {
    // Found driving the page on a live stack: a project's creator who also has a
    // direct project_members row rendered twice under that project (React
    // duplicate-key warning). The tree shows who holds access at a node; the
    // person view is where every separate grant is itemised.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 1, 700)",
    ).run()
    const body = (await (await orgAccess("owner")).json()) as Payload
    const p1 = body.tree.flatMap(flatten).filter((n) => n.scope.type === "project" && n.scope.id === "p1")
    for (const node of p1) {
      const names = node.directGrantees.map((g) => g.displayName)
      expect(names).toEqual([...new Set(names)])
    }
    expect(p1.some((n) => n.directGrantees.some((g) => g.displayName === "owner"))).toBe(true)
  })

  it("an outsider gets 403", async () => {
    expect((await orgAccess("personal")).status).toBe(403)
  })

  // Review finding: 404-for-missing vs 403-for-existing let any user probe
  // which org ids exist. Both must be indistinguishable.
  it("a project lists the org grant and the team grant as inherited, and the direct grant here", async () => {
    const body = (await (await orgAccess("owner")).json()) as Payload
    const project = findPlace(body, "project", "p1")
    expect(project).toBeTruthy()
    const maintainer = project!.inherited.find((row) => row.kind === "person" && row.displayName === "maintainer")
    expect(maintainer).toMatchObject({ roleLevel: 600, from: { type: "org", name: "Fixture Org" } })
    const team = project!.inherited.find((row) => row.kind === "team")
    expect(team).toMatchObject({
      roleLevel: 400,
      memberCount: 3,
      from: { type: "team", name: "fixture/translators" },
    })
    expect(project!.directGrantees.some((g) => g.displayName === "direct_below" && g.roleLevel === 300)).toBe(true)
    // The sentence the lens renders is these row counts, not a second arithmetic.
    const counts = placeRowCounts(project!)
    expect(counts).toEqual({
      granted: project!.directGrantees.length,
      reaches: project!.inherited.length,
      total: project!.directGrantees.length + project!.inherited.length,
    })
  })

  it("a language lane inherits the project grant and keeps a grant that names only the other lane", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position) VALUES
         ('lanefr01', 'p1', 'target', 'French', 'French', 'fr', 0),
         ('lanees01', 'p1', 'target', 'Spanish', 'Spanish', 'es', 1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
       VALUES ('p1', 6, 'lanefr01', 300, 1)`,
    ).run()
    // The creator also has a direct project row. Both are the same place, so
    // the lane lists that person once under the project, not twice.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', 1, 700, 1)`,
    ).run()
    const body = (await (await orgAccess("owner")).json()) as Payload
    const french = findPlace(body, "lane", "lanefr01")
    const spanish = findPlace(body, "lane", "lanees01")
    expect(french?.scope.name).toBe("French")
    expect(spanish?.scope.name).toBe("Spanish")
    const viaProject = (node: Node | undefined) =>
      node?.inherited.filter((row) => row.from.type === "project" && row.displayName === "direct_below") ?? []
    expect(viaProject(french)).toEqual([expect.objectContaining({ roleLevel: 300, from: { type: "project", id: "p1", name: "Alpha" } })])
    const ownerViaProject = french?.inherited.filter((row) => row.from.type === "project" && row.displayName === "owner") ?? []
    expect(ownerViaProject).toHaveLength(1)
    expect(viaProject(spanish)).toEqual([expect.objectContaining({ roleLevel: 300, from: { type: "project", id: "p1", name: "Alpha" } })])
    expect(french?.directGrantees.some((g) => g.displayName === "direct_below")).toBe(true)
    expect(spanish?.directGrantees.some((g) => g.displayName === "direct_below")).toBe(false)
  })

  it("a project grant with no org grant is a guest, and an org grant clears it", async () => {
    const before = (await (await orgAccess("owner")).json()) as Payload
    const guest = findPlace(before, "project", "p2")?.directGrantees.find((g) => g.displayName === "external")
    expect(guest?.isGuest).toBe(true)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 9, 100, 1)",
    ).run()
    const after = (await (await orgAccess("owner")).json()) as Payload
    const member = findPlace(after, "project", "p2")?.directGrantees.find((g) => g.displayName === "external")
    expect(member?.isGuest).toBe(false)
  })

  it("a pending project invite is granted here, with its expiry", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at)
       VALUES ('inv-soon', 'p1', 300, 1, 'soon@example.com', now() + interval '3 days')`,
    ).run()
    const body = (await (await orgAccess("owner")).json()) as Payload
    const invite = findPlace(body, "project", "p1")?.directGrantees.find((g) => g.email === "soon@example.com")
    expect(invite).toMatchObject({ source: "invite", roleLevel: 300 })
    expect(invite?.pendingInvite?.expiresAt).toEqual(expect.any(String))
    const person = body.people.find((p) => p.email === "soon@example.com")
    expect(person?.pendingInvite?.roleLevel).toBe(300)
    expect(person?.grants.some((g) => g.scopePath.some((scope) => scope.id === "p1"))).toBe(true)
  })

  it("AQU-2320: each place says whether this viewer may give access there, by the rule the dry run applies", async () => {
    type G = Record<string, { ok: true; cap: number } | { ok: false; denial: string }>
    const owner = ((await (await orgAccess("owner")).json()) as { grantable: G }).grantable
    expect(owner["org:1"]).toEqual({ ok: true, cap: 700 })
    expect(owner["project:p1"]).toEqual({ ok: true, cap: 700 })
    const maintainer = ((await (await orgAccess("maintainer")).json()) as { grantable: G }).grantable
    // The dialog greys the org with "Only an Owner can grant here" from this.
    expect(maintainer["org:1"]).toEqual({ ok: false, denial: "owner_only" })
    expect(maintainer["team:1"]).toEqual({ ok: true, cap: 600 })
    // fixture/leads holds Owner on p3: joining it would hand a Maintainer's grantee more than they hold.
    expect(maintainer["team:2"]).toEqual({ ok: false, denial: "team_above_you" })
  })

  it("a missing org and an invisible org return the identical 403 (no id enumeration)", async () => {
    const hidden = await orgAccess("personal")
    const missing = await orgAccess("personal", 999999)
    expect(missing.status).toBe(403)
    expect(await missing.json()).toEqual(await hidden.json())
  })
})
