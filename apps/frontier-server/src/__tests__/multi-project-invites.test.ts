// Tests for multi-project invites (Aquilla spec 03-data-model.md §"Project
// invite"). One token, N rows in project_invites; accept materializes N
// project_members rows.

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
    preferences: "{}",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

async function frontierJwt(username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: username, iat: now, exp: now + 3600 }, SECRET, "HS256")
}

function makeEnv(db: ReturnType<typeof makeFakeD1>): Env {
  return {
    AQUILLA_DB: db,
    SECRET_KEY: SECRET,
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
    SYNC_SECRET_KEY: "sync-secret",
  }
}

describe("POST /api/v2/invites/multi", () => {
  it("creates one row per project sharing the same token + role + expiry", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
        {
          id: "p2",
          name: "P2",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
        {
          id: "p3",
          name: "P3",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/invites/multi",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectIds: ["p1", "p2", "p3"],
          roleLevel: 400,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      projectIds: string[]
      role: number
      expiresAt: string
    }
    expect(body.token.length).toBeGreaterThan(8)
    expect(body.projectIds.sort()).toEqual(["p1", "p2", "p3"])
    expect(body.role).toBe(400)

    const rows = db._tables().project_invites
    expect(rows).toHaveLength(3)
    // Same token + same expiry across rows.
    expect(new Set(rows.map((r) => r.token))).toEqual(new Set([body.token]))
    expect(new Set(rows.map((r) => r.role_level))).toEqual(new Set([400]))
    expect(new Set(rows.map((r) => r.project_id))).toEqual(
      new Set(["p1", "p2", "p3"]),
    )
  })

  it("caps link role at contributor (400)", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/invites/multi",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectIds: ["p1"],
          roleLevel: 700, // try to grant owner via link — should clamp
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: number }
    expect(body.role).toBe(400)
  })

  it("rejects when the caller is missing project_lead on any single project", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "owned-by-bob",
          name: "Bob's",
          org_id: null,
          created_by: 2, // bob is owner here
          archived_at: null,
        },
        {
          id: "not-bobs",
          name: "Other",
          org_id: null,
          created_by: 99, // bob has no role here
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/invites/multi",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectIds: ["owned-by-bob", "not-bobs"],
          roleLevel: 400,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(404)
    // No partial-success rows.
    expect(db._tables().project_invites).toHaveLength(0)
  })

  it("404s for unknown project ids", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/invites/multi",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectIds: ["p1", "ghost"],
          roleLevel: 400,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(404)
  })
})

describe("POST /api/v2/invites/:token/accept", () => {
  it("materializes a project_members row for EVERY project sharing the token", async () => {
    const sharedToken = "shared-multi-tok-aaaaaaaa"
    const expiresAt = new Date(Date.now() + 86400000).toISOString()
    const db = makeFakeD1({
      users: [makeUser(1, "alice"), makeUser(2, "bob")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
        {
          id: "p2",
          name: "P2",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_invites: [
        {
          token: sharedToken,
          project_id: "p1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
          used_by: null,
          used_at: null,
        },
        {
          token: sharedToken,
          project_id: "p2",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
          used_by: null,
          used_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      `/api/v2/invites/${sharedToken}/accept`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      token: string
      accepted: Array<{ projectId: string; role: number }>
    }
    expect(body.token).toBe(sharedToken)
    expect(body.accepted.map((a) => a.projectId).sort()).toEqual(["p1", "p2"])

    const members = db._tables().project_members
    expect(members.filter((m) => m.user_id === 2)).toHaveLength(2)
    expect(members.map((m) => m.project_id).sort()).toEqual(["p1", "p2"])

    // Every invite row stamped used_by + used_at.
    const invites = db._tables().project_invites
    expect(invites.every((r) => r.used_by === 2 && r.used_at != null)).toBe(true)
  })

  it("preview returns N projects for a multi-token", async () => {
    const sharedToken = "preview-multi-tok-zzzzzz"
    const expiresAt = new Date(Date.now() + 86400000).toISOString()
    const db = makeFakeD1({
      projects: [
        {
          id: "p1",
          name: "Genesis MVP",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
        {
          id: "p2",
          name: "Exodus MVP",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_invites: [
        {
          token: sharedToken,
          project_id: "p1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
          used_by: null,
          used_at: null,
        },
        {
          token: sharedToken,
          project_id: "p2",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
          used_by: null,
          used_at: null,
        },
      ],
    })
    const res = await app.request(
      `/api/v2/invites/${sharedToken}/preview`,
      { method: "GET" },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ projectId: string; projectName: string }>
      role: { level: number; name: string }
    }
    expect(body.projects.map((p) => p.projectId).sort()).toEqual(["p1", "p2"])
    expect(body.role).toEqual({ level: 400, name: "contributor" })
  })

  it("410s expired multi-tokens", async () => {
    const sharedToken = "expired-multi-tok-yyyyyy"
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_invites: [
        {
          token: sharedToken,
          project_id: "p1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() - 60_000).toISOString(),
          used_by: null,
          used_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      `/api/v2/invites/${sharedToken}/accept`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(410)
  })

  it("404s unknown tokens", async () => {
    const db = makeFakeD1({ users: [makeUser(2, "bob")] })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/invites/nonexistent-token/accept",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(404)
  })

  it("doesn't demote an existing maintainer on accept", async () => {
    const sharedToken = "preserve-role-tok-12345"
    const expiresAt = new Date(Date.now() + 86400000).toISOString()
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_members: [
        {
          project_id: "p1",
          user_id: 2,
          role_level: 600, // maintainer
          granted_by: 1,
          granted_at: new Date().toISOString(),
        },
      ],
      project_invites: [
        {
          token: sharedToken,
          project_id: "p1",
          role_level: 400,
          created_by: 1,
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
          used_by: null,
          used_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      `/api/v2/invites/${sharedToken}/accept`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accepted: Array<{ projectId: string; role: number }>
    }
    expect(body.accepted).toEqual([{ projectId: "p1", role: 600 }])
  })
})
