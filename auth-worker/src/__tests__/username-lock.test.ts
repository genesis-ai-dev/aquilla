// AQU-436: Username self-change lock
//
// Verifies the acceptance criteria:
//   1. Finding: there is no route today for a user to change their own username
//      or password while authenticated — documented by the "no such route" cases.
//   2. A Contributor cannot change their own username via PATCH /api/v2/auth/me.
//   3. A Contributor cannot change their own password via PATCH /api/v2/auth/me.
//   4. Safe preference updates via PATCH /api/v2/auth/me are allowed for any role.
//   5. Maintainer/Owner cannot bypass the username lock via the same PATCH route
//      (there is no self-service override — see SWARM-TODO in auth.ts for the
//      org-managed reset path decision).

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function patchMe(
  jwt: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    "/api/v2/auth/me",
    {
      method: "PATCH",
      headers: authHeader(jwt),
      body: JSON.stringify(body),
    },
    env,
  )
}

describe("PATCH /api/v2/auth/me — username lock (AQU-436)", () => {
  it("blocks a Contributor from changing their own username (403)", async () => {
    await seedUser(1, "alice")
    const jwt = await jwtFor("alice")
    const res = await patchMe(jwt, { username: "new-alice" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/username/i)
  })

  it("blocks a Maintainer from self-changing their username too (403)", async () => {
    // AQU-436: the lock is unconditional for self-service — no role override exists.
    await seedUser(2, "bob")
    const jwt = await jwtFor("bob")
    const res = await patchMe(jwt, { username: "new-bob" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/username/i)
  })

  it("blocks a self-serve password change via `password` field (403)", async () => {
    await seedUser(3, "carol")
    const jwt = await jwtFor("carol")
    const res = await patchMe(jwt, { password: "new-password-99" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/password/i)
  })

  it("blocks a self-serve password change via `new_password` field (403)", async () => {
    await seedUser(4, "dave")
    const jwt = await jwtFor("dave")
    const res = await patchMe(jwt, { new_password: "new-password-99" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/password/i)
  })

  it("allows updating preferences (safe non-identity field)", async () => {
    await seedUser(5, "eve")
    const jwt = await jwtFor("eve")
    const res = await patchMe(jwt, { preferences: { theme: "light" } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      username: string
      preferences: Record<string, unknown>
    }
    // Username is unchanged.
    expect(body.username).toBe("eve")
    expect(body.preferences.theme).toBe("light")
  })

  it("no-ops when the patch body has no fields (200, identity unchanged)", async () => {
    await seedUser(6, "frank")
    const jwt = await jwtFor("frank")
    const res = await patchMe(jwt, {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as { username: string }
    expect(body.username).toBe("frank")
  })

  it("returns 401 without authentication", async () => {
    const res = await app.request(
      "/api/v2/auth/me",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "hacker" }),
      },
      env,
    )
    expect(res.status).toBe(401)
  })
})
