import { describe, it, expect, vi } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import type { Env } from "../types"
import { makeFakeD1, type UserRow } from "./helpers/d1-fake"

const SECRET = "frontier-test-secret"

function makeUser(): UserRow {
  return {
    id: 1,
    username: "alice",
    email: "alice@example.com",
    password_hash: "scrypt:32768:8:1$salt$" + "ab".repeat(64),
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
    AQUILLA_DB: db,
    SECRET_KEY: SECRET,
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
    SYNC_SECRET_KEY: "sync-secret",
  }
}

describe("POST /api/v2/projects", () => {
  it("creates the project even if personal org setup is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const db = makeFakeD1({ users: [makeUser()] })
    const jwt = await frontierJwt("alice")

    const res = await app.request(
      "/api/v2/projects",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: "proj-1", name: "Project One" }),
      },
      makeEnv(db),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      name: string
      orgId: number | null
      role: { level: number; name: string; source: string }
    }
    expect(body).toMatchObject({
      id: "proj-1",
      name: "Project One",
      orgId: null,
      role: { level: 700, name: "owner", source: "creator" },
    })
    expect(db._tables().projects).toEqual([
      expect.objectContaining({
        id: "proj-1",
        name: "Project One",
        org_id: null,
        created_by: 1,
      }),
    ])
    warn.mockRestore()
  })
})
