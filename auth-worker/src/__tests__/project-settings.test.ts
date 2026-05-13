// Tests for /api/v2/projects/:projectId/settings — versioned JSON settings
// with optimistic-concurrency (Aquilla spec 03-data-model.md §"Project
// Settings"). Happy path + 409 on version mismatch + role gating.

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

describe("GET /api/v2/projects/:projectId/settings", () => {
  it("returns empty defaults when no row exists yet", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projectId: string
      settings: Record<string, unknown>
      version: number
    }
    expect(body.projectId).toBe("proj-1")
    expect(body.settings).toEqual({})
    expect(body.version).toBe(0)
  })

  it("403s non-members", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 99,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(403)
  })
})

describe("PUT /api/v2/projects/:projectId/settings", () => {
  it("writes settings at version 0, returns version 1", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 1, // owner via creator tier
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          settings: { sourceLanguage: "en", targetLanguage: "es" },
          ifMatchVersion: 0,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: number
      settings: Record<string, unknown>
    }
    expect(body.version).toBe(1)
    expect(body.settings).toEqual({ sourceLanguage: "en", targetLanguage: "es" })
    expect(db._tables().project_settings).toHaveLength(1)
    expect(db._tables().project_settings[0]).toMatchObject({
      project_id: "proj-1",
      version: 1,
    })
  })

  it("409s on version mismatch and returns current row", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_settings: [
        {
          project_id: "proj-1",
          settings: JSON.stringify({ sourceLanguage: "fr" }),
          version: 3,
          updated_at: new Date().toISOString(),
          updated_by: 1,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          settings: { sourceLanguage: "de" },
          ifMatchVersion: 1, // stale!
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: string
      current: { version: number; settings: Record<string, unknown> }
    }
    expect(body.error).toContain("version mismatch")
    expect(body.current.version).toBe(3)
    expect(body.current.settings).toEqual({ sourceLanguage: "fr" })
    // Row was NOT updated.
    expect(db._tables().project_settings[0].version).toBe(3)
  })

  it("happy-path bump from version N to N+1 with a matching ifMatchVersion", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      project_settings: [
        {
          project_id: "proj-1",
          settings: JSON.stringify({ validationCount: 1 }),
          version: 7,
          updated_at: new Date().toISOString(),
          updated_by: 1,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          settings: { validationCount: 2 },
          ifMatchVersion: 7,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { version: number }
    expect(body.version).toBe(8)
    expect(db._tables().project_settings[0].version).toBe(8)
  })

  it("rejects callers below maintainer (600)", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 99,
          archived_at: null,
        },
      ],
      project_members: [
        {
          project_id: "proj-1",
          user_id: 2,
          role_level: 500, // project_lead — below 600
          granted_by: 99,
          granted_at: new Date().toISOString(),
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          settings: { sourceLanguage: "en" },
          ifMatchVersion: 0,
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(403)
  })

  it("requires ifMatchVersion (no force-write path)", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ settings: { foo: "bar" } }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(400)
  })

  it("accepts ifMatchVersion via If-Match-Version header", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/proj-1/settings",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "If-Match-Version": "0",
        },
        body: JSON.stringify({ settings: { healthSettings: { threshold: 0.9 } } }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { version: number }
    expect(body.version).toBe(1)
  })
})
