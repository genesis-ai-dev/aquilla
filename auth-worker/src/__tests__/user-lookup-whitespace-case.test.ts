// FRO-457: GET /api/v2/users/lookup falsely reported "user not found" when
// the queried username had leading/trailing whitespace (e.g. pasted from
// elsewhere), or differed only in case, even though a matching user exists.
//
// Root cause: the route validated `username.trim() !== ""` but then passed
// the ORIGINAL untrimmed username to lookupUserByUsername, whose SQL is a
// plain `WHERE username = ?` — whitespace- and case-sensitive against
// Postgres. This test asserts the lookup is now trimmed + case-insensitive,
// while a genuinely-absent username still 404s.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

describe("GET /api/v2/users/lookup — whitespace/case robustness (FRO-457)", () => {
  it("resolves a user when the query has trailing whitespace", async () => {
    await seedUser(300, "wsuser-trail")
    await seedUser(301, "caller-ws-1")

    const res = await app.request(
      `/api/v2/users/lookup?username=${encodeURIComponent("wsuser-trail ")}`,
      { method: "GET", headers: authHeader(await jwtFor("caller-ws-1")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; username: string }
    expect(body.username).toBe("wsuser-trail")
  })

  it("resolves a user when the query has leading whitespace", async () => {
    await seedUser(302, "wsuser-lead")
    await seedUser(303, "caller-ws-2")

    const res = await app.request(
      `/api/v2/users/lookup?username=${encodeURIComponent("  wsuser-lead")}`,
      { method: "GET", headers: authHeader(await jwtFor("caller-ws-2")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; username: string }
    expect(body.username).toBe("wsuser-lead")
  })

  it("resolves a user when the query differs only in case", async () => {
    await seedUser(304, "CaseUser")
    await seedUser(305, "caller-case-1")

    const res = await app.request(
      `/api/v2/users/lookup?username=${encodeURIComponent("caseuser")}`,
      { method: "GET", headers: authHeader(await jwtFor("caller-case-1")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; username: string }
    // Returns the exact stored row, not the caller's casing.
    expect(body.username).toBe("CaseUser")
  })

  it("still 404s for a genuinely-absent username", async () => {
    await seedUser(306, "caller-absent-1")

    const res = await app.request(
      `/api/v2/users/lookup?username=${encodeURIComponent("nobody-with-this-name")}`,
      { method: "GET", headers: authHeader(await jwtFor("caller-absent-1")) },
      env,
    )
    expect(res.status).toBe(404)
  })

  it("still 404s for whitespace-padded absent username (not just blank-string bypass)", async () => {
    await seedUser(307, "caller-absent-2")

    const res = await app.request(
      `/api/v2/users/lookup?username=${encodeURIComponent("   nobody-either   ")}`,
      { method: "GET", headers: authHeader(await jwtFor("caller-absent-2")) },
      env,
    )
    expect(res.status).toBe(404)
  })
})
