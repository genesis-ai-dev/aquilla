import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedProject(id: string, name: string) {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)").bind(id, name).run()
}

describe("invite email persistence", () => {
  it("persists the email on create and returns it from preview", async () => {
    await seedUser(1, "wendi")
    await seedProject("pa", "John")
    const created = await app.request(
      "/api/v2/projects/pa/invites",
      { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ email: "joiner@example.com" }) },
      env,
    )
    expect(created.status).toBe(200)
    const { token } = (await created.json()) as { token: string }

    const row = await env.AQUILLA_PG.prepare("SELECT email FROM project_invites WHERE token = ?").bind(token).first<{ email: string | null }>()
    expect(row?.email).toBe("joiner@example.com")

    const preview = await app.request(`/api/v2/projects/invite-preview/${token}`, {}, env)
    expect(preview.status).toBe(200)
    expect(((await preview.json()) as { email: string | null }).email).toBe("joiner@example.com")
  })

  it("returns null email for an invite created without one", async () => {
    await seedUser(1, "wendi")
    await seedProject("pb", "Mark")
    const created = await app.request(
      "/api/v2/projects/pb/invites",
      { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({}) },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    const preview = await app.request(`/api/v2/projects/invite-preview/${token}`, {}, env)
    expect(((await preview.json()) as { email: string | null }).email).toBeNull()
  })
})
