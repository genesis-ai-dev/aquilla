// AQU-2259: the dev login knew only four people (dev, alice, bob, carol), so
// nobody could check the Viewer or Commenter views locally — which is how
// "Security disabled with no reason" went unseen. The seed now has one of each.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"

const local = { ...env, WRANGLER_LOCAL: "1" } as typeof env

async function devLogin(username: string): Promise<Response> {
  return app.request("/__dev__/login", { method: "POST", body: JSON.stringify({ username }) }, local)
}

async function roleOn(table: "org_members" | "project_members", username: string): Promise<number | null> {
  const where = table === "org_members"
    ? "m.org_id = (SELECT id FROM organizations WHERE name = 'Dev Org')"
    : "m.project_id = 'dev-project'"
  const row = await env.AQUILLA_PG.prepare(
    `SELECT m.role_level FROM ${table} m JOIN users u ON u.id = m.user_id WHERE u.username = ? AND ${where}`,
  ).bind(username).first<{ role_level: number }>()
  return row ? Number(row.role_level) : null
}

describe("dev seed: a Viewer and a Commenter (AQU-2259)", () => {
  it("signs in vera, a Viewer on Dev Org and Dev Project", async () => {
    const res = await devLogin("vera")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ username: "vera" })
    expect(await roleOn("org_members", "vera")).toBe(100)
    expect(await roleOn("project_members", "vera")).toBe(100)
  })

  it("signs in cora, a Commenter on Dev Org and Dev Project", async () => {
    const res = await devLogin("cora")
    expect(res.status).toBe(200)
    expect(await roleOn("org_members", "cora")).toBe(200)
    expect(await roleOn("project_members", "cora")).toBe(200)
  })
})
