/**
 * GET /api/v2/orgs/:orgId/access must never hand out a redeemable invite token.
 *
 * AQU-2318 added pending invites to the People & access tree. An invite token
 * is a bearer credential: anyone signed in can redeem an open-link invite
 * (no email) for its role. The tree is readable by anyone who can see the org
 * roster or one project's roster, which is a much wider group than the people
 * allowed to list invites (GET /orgs/:id/invites is owner-only; GET
 * /projects/:id/invites needs Project lead). So the tree must:
 *   - never carry the token itself, in any field;
 *   - show a pending invite only to a viewer who passes the listing gate for
 *     that place.
 * Without this, an org that opens its roster to everyone lets a Translator read
 * an open Maintainer link and redeem it for themselves.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor } from "./helpers/db"
import { FIXTURE_ORG_ID, seedAccessFixture, type FixtureUser } from "./helpers/access-fixture"

interface Grantee { userId: string; displayName: string; email?: string | null; source?: string }
interface Node { scope: { type: string; id: string }; children: Node[]; directGrantees: Grantee[] }
interface Payload { tree: Node[] }

const ORG_TOKEN = "org-open-link-token-0001"
const PROJECT_TOKEN = "project-open-link-token-0001"

const flatten = (n: Node): Node[] => [n, ...n.children.flatMap(flatten)]
const invitesIn = (p: Payload) =>
  p.tree.flatMap(flatten).flatMap((n) => n.directGrantees.filter((g) => g.source === "invite").map((g) => ({ place: n.scope, g })))

async function accessFor(viewer: FixtureUser): Promise<{ text: string; body: Payload }> {
  const res = await app.request(
    `/api/v2/orgs/${FIXTURE_ORG_ID}/access`,
    { headers: authHeader(await jwtFor(viewer)) },
    env,
  )
  expect(res.status).toBe(200)
  const text = await res.text()
  return { text, body: JSON.parse(text) as Payload }
}

async function openRosterToEveryone(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{\"rosterViewMinRole\":100}', 1, 1)",
  ).run()
}

beforeEach(async () => {
  await seedAccessFixture()
  // Open links: no email, so any signed-in account can redeem them.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_invites (token, org_id, role_level, created_by, email, expires_at)
     VALUES (?, 1, 600, 1, NULL, now() + interval '3 days')`,
  ).bind(ORG_TOKEN).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_invites (token, project_id, role_level, created_by, email, expires_at)
     VALUES (?, 'p1', 400, 1, NULL, now() + interval '3 days')`,
  ).bind(PROJECT_TOKEN).run()
})

describe("org access tree keeps invite tokens private", () => {
  it("a Translator in an org with an open roster cannot read the invites, so cannot redeem the Maintainer link", async () => {
    // team_only: org 300, p1 at 400 via team. Below both invite-listing gates.
    await openRosterToEveryone()
    const { text, body } = await accessFor("team_only")
    expect(body.tree[0].scope.type).toBe("org")
    expect(text).not.toContain(ORG_TOKEN)
    expect(text).not.toContain(PROJECT_TOKEN)
    expect(invitesIn(body)).toEqual([])

    // The listing routes refuse this viewer too: the tree must not be a side door.
    const orgList = await app.request(`/api/v2/orgs/1/invites`, { headers: authHeader(await jwtFor("team_only")) }, env)
    expect(orgList.status).toBe(403)
    const projectList = await app.request(`/api/v2/projects/p1/invites`, { headers: authHeader(await jwtFor("team_only")) }, env)
    expect(projectList.status).toBe(403)
  })

  it("an org Maintainer sees project invites they could list, but not org invites, and never a token", async () => {
    // Default roster floor: Maintainer reads the org tree. Org invites are owner-only.
    const { text, body } = await accessFor("maintainer")
    expect(text).not.toContain(ORG_TOKEN)
    expect(text).not.toContain(PROJECT_TOKEN)
    const places = invitesIn(body).map((i) => `${i.place.type}:${i.place.id}`)
    expect(places).toEqual(["project:p1"])
  })

  it("the owner still sees every pending invite, labelled without the token", async () => {
    const { text, body } = await accessFor("owner")
    expect(text).not.toContain(ORG_TOKEN)
    expect(text).not.toContain(PROJECT_TOKEN)
    const invites = invitesIn(body)
    expect(invites.map((i) => `${i.place.type}:${i.place.id}`).sort()).toEqual(["org:1", "project:p1"])
    for (const { g } of invites) {
      // The SPA keys rows by userId and keeps invite rows out of the member inspector by this prefix.
      expect(g.userId.startsWith("invite:")).toBe(true)
      expect(g.displayName).not.toBe("")
    }
    // Two invites at different places never share an id.
    expect(new Set(invites.map((i) => i.g.userId)).size).toBe(2)
  })
})
