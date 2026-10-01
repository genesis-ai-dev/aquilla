/**
 * AQU-1352 review blocker: legacy personal workspaces have billing_scope NULL
 * (migration 0092 added the column without a backfill). Matching only
 * billing_scope = 'personal' missed them, so POST /projects without orgId
 * lazily created a duplicate empty "<username>'s workspace" and the user's
 * real projects vanished from their default workspace. A 'team' org must
 * still never be treated as personal.
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function orgsOwnedBy(userId: number): Promise<Array<{ id: number; billing_scope: string | null }>> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT id, billing_scope FROM organizations WHERE owner_user_id = ? ORDER BY id",
  ).bind(userId).all<{ id: number; billing_scope: string | null }>()
  return (rows.results ?? []).map((r) => ({ id: Number(r.id), billing_scope: r.billing_scope }))
}

async function addOrg(id: number, name: string, owner: number, scope: string | null) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, ?, ?, ?)",
  ).bind(id, name, owner, scope).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, 700, ?)",
  ).bind(id, owner, owner).run()
}

async function createProject(username: string, id: string) {
  return app.request(
    "/api/v2/projects",
    { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify({ id, name: id }) },
    env,
  )
}

async function targets(username: string): Promise<Array<{ kind: string; orgId: number | null }>> {
  const res = await app.request("/api/v2/me/create-targets", { headers: authHeader(await jwtFor(username)) }, env)
  expect(res.status).toBe(200)
  return (await res.json()) as Array<{ kind: string; orgId: number | null }>
}

describe("AQU-1352 personal org resolution with legacy NULL billing_scope", () => {
  it("a legacy NULL-scope workspace is the personal org: no duplicate, project lands in it", async () => {
    await seedUser(1, "legacy")
    await addOrg(20, "legacy's workspace", 1, null)
    const res = await createProject("legacy", "p-legacy")
    expect(res.status).toBe(200)
    expect(await orgsOwnedBy(1)).toHaveLength(1)
    const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'p-legacy'").first<{ org_id: number }>()
    expect(Number(row?.org_id)).toBe(20)
    const t = await targets("legacy")
    expect(t.filter((x) => x.kind === "personal")).toEqual([expect.objectContaining({ orgId: 20 })])
    expect(t.filter((x) => x.orgId === 20)).toHaveLength(1)
  })

  it("a legacy NULL-scope org that other people belong to is listed by name, never as Personal", async () => {
    // Found on a live stack: an owner of a shared legacy org ("Dev Org", three
    // members) saw it offered as "Personal" in the create dialog. Legacy orgs
    // are ambiguous; a co-member makes it a shared org, so the picker must name
    // it. Creating without an orgId still lands in it (no duplicate workspace).
    await seedUser(1, "owner")
    await seedUser(2, "colleague")
    await addOrg(30, "Shared Legacy Org", 1, null)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (30, 2, 400, 1)",
    ).run()
    const t = (await targets("owner")) as Array<{ kind: string; orgId: number | null; name?: string }>
    expect(t.filter((x) => x.kind === "personal")).toEqual([])
    expect(t.filter((x) => x.orgId === 30)).toEqual([expect.objectContaining({ kind: "org", name: "Shared Legacy Org" })])
    const res = await createProject("owner", "p-shared")
    expect(res.status).toBe(200)
    expect(await orgsOwnedBy(1)).toHaveLength(1)
  })

  it("an owned TEAM org is never picked as personal", async () => {
    await seedUser(1, "teamowner")
    await addOrg(30, "Team", 1, "team")
    const t = await targets("teamowner")
    expect(t.find((x) => x.kind === "personal")).toMatchObject({ orgId: null })
    expect(t.find((x) => x.orgId === 30)).toMatchObject({ kind: "org" })
    expect((await createProject("teamowner", "p-team")).status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'p-team'").first<{ org_id: number }>()
    expect(Number(row?.org_id)).not.toBe(30)
  })

  it("an explicit 'personal' org wins over a legacy NULL-scope org", async () => {
    await seedUser(1, "both")
    await addOrg(40, "old", 1, null)
    await addOrg(41, "both's workspace", 1, "personal")
    const t = await targets("both")
    expect(t.find((x) => x.kind === "personal")).toMatchObject({ orgId: 41 })
    expect((await createProject("both", "p-both")).status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'p-both'").first<{ org_id: number }>()
    expect(Number(row?.org_id)).toBe(41)
  })
})
