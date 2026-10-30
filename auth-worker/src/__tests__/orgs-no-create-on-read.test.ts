// AQU-2259: opening a page never creates an organization. `GET /orgs/me` (asked
// by Project settings and the members matrix) and `GET /orgs` (session boot,
// the org switcher, billing) used to create "<name>'s workspace" for anyone who
// owned none — carol in the Oct 28 demo got one just by opening Project
// settings. They now answer "no organization"; a personal workspace is made
// only when someone chooses one: onboarding's "Just me" (POST /orgs/personal),
// a personal project (POST /projects), or Create organization (POST /orgs).
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function orgCount(): Promise<number> {
  const row = await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM organizations").first<{ n: number }>()
  return row?.n ?? 0
}

async function call(path: string, username: string, method = "GET") {
  return app.request(path, { method, headers: authHeader(await jwtFor(username)) }, env)
}

describe("reading your organization creates nothing (AQU-2259)", () => {
  it("GET /orgs/me answers no organization for someone who owns none", async () => {
    await seedUser(1, "carol")
    const res = await call("/api/v2/orgs/me", "carol")
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "no_organization" })
    expect(await orgCount()).toBe(0)
  })

  it("GET /orgs/me still answers with the personal workspace someone has", async () => {
    await seedUser(1, "dana")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (5, 'Dana home', 1, 'personal')",
    ).run()
    const res = await call("/api/v2/orgs/me", "dana")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 5, name: "Dana home", role: { level: 700 } })
  })

  it("an invited member who owns nothing gets no workspace from GET /orgs/me", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "carol")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Team', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
    ).run()
    expect((await call("/api/v2/orgs/me", "carol")).status).toBe(404)
    expect(await orgCount()).toBe(1)
  })

  it("GET /orgs lists nothing, and creates nothing, for a brand-new account", async () => {
    await seedUser(3, "newbie")
    const res = await call("/api/v2/orgs", "newbie")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { orgs: unknown[] }).orgs).toEqual([])
    expect(await orgCount()).toBe(0)
  })

  it("the portfolio totals for an account with no organization create nothing", async () => {
    await seedUser(3, "newbie")
    const res = await app.request("/api/v2/orgs/portfolio/summary", {
      method: "POST", headers: authHeader(await jwtFor("newbie")), body: JSON.stringify({}),
    }, env)
    expect(res.status).toBe(200)
    expect(await orgCount()).toBe(0)
  })

  it("POST /orgs/personal makes the personal workspace when someone chooses it, once", async () => {
    await seedUser(3, "newbie")
    const first = await call("/api/v2/orgs/personal", "newbie", "POST")
    expect(first.status).toBe(200)
    const created = (await first.json()) as { id: number; name: string; role: { level: number } }
    expect(created).toMatchObject({ name: "newbie's workspace", role: { level: 700 } })
    const again = (await (await call("/api/v2/orgs/personal", "newbie", "POST")).json()) as { id: number }
    expect(again.id).toBe(created.id)
    expect(await orgCount()).toBe(1)
    const row = await env.AQUILLA_PG.prepare("SELECT billing_scope FROM organizations WHERE id = ?")
      .bind(created.id).first<{ billing_scope: string }>()
    expect(row?.billing_scope).toBe("personal")
  })
})
