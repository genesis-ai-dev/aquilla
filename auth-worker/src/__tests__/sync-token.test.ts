import { describe, it, expect } from "vitest"
import { sign, verify } from "hono/jwt"
import app from "../index"
import type { Env } from "../types"
import { makeFakeD1, type UserRow } from "./helpers/d1-fake"

const SECRET = "frontier-test-secret"
const SYNC_SECRET = "sync-test-secret"

function makeUser(): UserRow {
  return {
    id: 42,
    username: "alice",
    email: "alice@example.com",
    password_hash: "scrypt:32768:8:1$saltsaltsalt$" + "ab".repeat(64),
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
    CODEX_DB: db,
    SECRET_KEY: SECRET,
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
    SYNC_SECRET_KEY: SYNC_SECRET,
  }
}

describe("POST /api/v2/sync-token", () => {
  it("mints a sync token for the project creator", async () => {
    const db = makeFakeD1({
      users: [makeUser()],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 42,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectId: "proj-1", fileId: "file-a" }),
      },
      makeEnv(db),
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
    const db = makeFakeD1({
      users: [makeUser()],
      projects: [
        {
          id: "proj-1",
          name: "Test",
          org_id: null,
          created_by: 99, // not the caller
          archived_at: null,
        },
      ],
      project_members: [
        {
          project_id: "proj-1",
          user_id: 42,
          role_level: 400,
          granted_by: 99,
          granted_at: new Date().toISOString(),
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectId: "proj-1", fileId: "file-a" }),
      },
      makeEnv(db),
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
    const db = makeFakeD1({ users: [makeUser()] })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: "proj-new",
          fileId: "file-a",
          projectName: "New Project",
        }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    expect(db._tables().projects).toHaveLength(1)
    expect(db._tables().projects[0]).toMatchObject({
      id: "proj-new",
      name: "New Project",
      created_by: 42,
    })
  })

  it("rejects unknown projects without a bootstrap payload with 403", async () => {
    const db = makeFakeD1({ users: [makeUser()] })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectId: "proj-unknown", fileId: "file-a" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(403)
  })

  it("returns 401 when no JWT is provided", async () => {
    const db = makeFakeD1({ users: [makeUser()] })
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1", fileId: "file-a" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(401)
  })
})
