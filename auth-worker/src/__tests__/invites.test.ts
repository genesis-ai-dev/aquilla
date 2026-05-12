import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import type { Env } from "../types"
import { makeFakeD1, type UserRow } from "./helpers/d1-fake"

const SECRET = "frontier-test-secret"

function makeUser(id: number, username: string): UserRow {
  return {
    id,
    username,
    email: `${username}@example.com`,
    password_hash: "scrypt:32768:8:1$salt$" + "ab".repeat(64),
    gitlab_user_id: id + 1000,
    gitlab_username: username,
    gitlab_token: "glpat-fake",
    stripe_customer_id: null,
    subscription_tier: "free",
    preferences: "{}",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

async function frontierJwt(username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign(
    { sub: username, iat: now, exp: now + 3600 },
    SECRET,
    "HS256",
  )
}

function makeEnv(db: ReturnType<typeof makeFakeD1>): Env {
  return {
    AUTH_DB: db,
    SECRET_KEY: SECRET,
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
    SYNC_SECRET_KEY: "sync-secret",
  }
}

describe("POST /api/v2/projects/:id/invites", () => {
  it("creates an invite for the project creator and caps role at contributor", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          gitlab_project_id: null,
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-1/invites",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        // Try to mint an OWNER-level link; server should cap to CONTRIBUTOR.
        body: JSON.stringify({ role: 700 }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      projectId: string
      role: number
    }
    expect(body.projectId).toBe("proj-1")
    expect(body.role).toBe(400)
    expect(body.token.length).toBeGreaterThan(8)
    expect(db._tables().project_invites).toHaveLength(1)
  })

  it("rejects users without project_lead+ role with 403", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          gitlab_project_id: null,
          org_id: null,
          created_by: 99,
          archived_at: null,
        },
      ],
      project_members: [
        {
          project_id: "proj-1",
          user_id: 2,
          role_level: 400, // contributor — below INVITE_MIN_ROLE
          granted_by: 99,
          granted_at: new Date().toISOString(),
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/proj-1/invites",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: 400 }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(403)
  })

  it("returns 404 for unknown projects", async () => {
    const db = makeFakeD1({ users: [makeUser(1, "alice")] })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-missing/invites",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: 400 }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(404)
  })
})

describe("POST /api/v2/projects/accept-invite", () => {
  it("adds the caller to project_members and stamps the invite", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice"), makeUser(2, "bob")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          gitlab_project_id: null,
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_invites: [
        {
          token: "share-token-abc",
          project_id: "proj-1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          used_by: null,
          used_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "share-token-abc" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projectId: string; role: number }
    expect(body).toEqual({ projectId: "proj-1", role: 400 })

    const members = db._tables().project_members
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({
      project_id: "proj-1",
      user_id: 2,
      role_level: 400,
    })
    const invite = db._tables().project_invites[0]
    expect(invite.used_by).toBe(2)
    expect(invite.used_at).not.toBeNull()
  })

  it("rejects expired invites with 410", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          gitlab_project_id: null,
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_invites: [
        {
          token: "expired-tok",
          project_id: "proj-1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() - 60000).toISOString(),
          used_by: null,
          used_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "expired-tok" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(410)
  })

  it("rejects unknown tokens with 404", async () => {
    const db = makeFakeD1({ users: [makeUser(2, "bob")] })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "no-such-token" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(404)
  })

  it("doesn't demote a maintainer who redeems a contributor invite", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          gitlab_project_id: null,
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_members: [
        {
          project_id: "proj-1",
          user_id: 2,
          role_level: 600,
          granted_by: 1,
          granted_at: new Date().toISOString(),
        },
      ],
      project_invites: [
        {
          token: "share-tok",
          project_id: "proj-1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          used_by: null,
          used_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "share-tok" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: number }
    expect(body.role).toBe(600)
  })
})

describe("GET /api/v2/projects/invite-preview/:token", () => {
  it("returns project + role metadata for a valid token (no auth)", async () => {
    const db = makeFakeD1({
      projects: [
        {
          id: "proj-1",
          name: "Genesis MVP",
          gitlab_project_id: null,
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_invites: [
        {
          token: "share-tok",
          project_id: "proj-1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          used_by: null,
          used_at: null,
        },
      ],
    })
    const res = await app.request(
      "/api/v2/projects/invite-preview/share-tok",
      { method: "GET" },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projectId: string
      projectName: string
      role: { level: number; name: string }
    }
    expect(body.projectId).toBe("proj-1")
    expect(body.projectName).toBe("Genesis MVP")
    expect(body.role).toEqual({ level: 400, name: "contributor" })
  })

  it("404s on unknown tokens", async () => {
    const db = makeFakeD1()
    const res = await app.request(
      "/api/v2/projects/invite-preview/bogus",
      { method: "GET" },
      makeEnv(db),
    )
    expect(res.status).toBe(404)
  })
})
