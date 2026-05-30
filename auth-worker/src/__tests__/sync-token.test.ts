import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { verify } from "hono/jwt"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/d1"

const SYNC_SECRET = "sync-secret"

describe("POST /api/v2/sync-token", () => {
  it("mints a sync token for the project creator", async () => {
    await seedUser(42, "alice")
    await env.AQUILLA_DB.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 42)",
    )
      .bind("proj-1", "Test")
      .run()
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ projectId: "proj-1", fileId: "file-a" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      expiresIn: number
      role: { level: number; name: string; source: string }
    }
    expect(body.expiresIn).toBe(900)
    expect(body.role).toEqual({ level: 700, name: "owner", source: "creator" })

    const claims = (await verify(body.token, SYNC_SECRET, "HS256")) as {
      userId: number
      username: string
      projectId: string
      fileId: string
      role: number
      aud: string
    }
    expect(claims).toMatchObject({
      userId: 42,
      username: "alice",
      projectId: "proj-1",
      fileId: "file-a",
      role: 700,
      aud: "sync",
    })
  })

  it("honors a project_members override over the creator default", async () => {
    await seedUser(42, "alice")
    await seedUser(99, "creator")
    await env.AQUILLA_DB.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 99)",
    )
      .bind("proj-1", "Test")
      .run()
    await env.AQUILLA_DB.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 99)",
    )
      .bind("proj-1", 42, 400)
      .run()
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ projectId: "proj-1", fileId: "file-a" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { source: string; level: number } }
    expect(body.role).toEqual({
      level: 400,
      name: "contributor",
      source: "override",
    })
  })

  it("auto-registers an unknown project when projectName is supplied", async () => {
    await seedUser(42, "alice")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({
          projectId: "proj-new",
          fileId: "file-a",
          projectName: "New Project",
        }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const project = await env.AQUILLA_DB.prepare(
      "SELECT id, name, created_by FROM projects WHERE id = 'proj-new'",
    ).first<{ id: string; name: string; created_by: number }>()
    expect(project).not.toBeNull()
    expect(project).toMatchObject({
      id: "proj-new",
      name: "New Project",
      created_by: 42,
    })
  })

  it("rejects unknown projects without a bootstrap payload with 403", async () => {
    await seedUser(42, "alice")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ projectId: "proj-unknown", fileId: "file-a" }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("returns 401 when no JWT is provided", async () => {
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1", fileId: "file-a" }),
      },
      env,
    )
    expect(res.status).toBe(401)
  })
})
