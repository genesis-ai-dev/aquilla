// Pen-test 2026-10-15: GET /api/v2/users/lookup is an exact username -> id
// oracle, so it is throttled per user. The cap is 60 per 15-minute window.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

describe("GET /api/v2/users/lookup rate limit", () => {
  it("429s with Retry-After once a user exceeds the per-window cap", async () => {
    await seedUser(300, "lookup-alice")
    const headers = authHeader(await jwtFor("lookup-alice"))
    let last: Response | undefined
    for (let i = 0; i < 61; i++) {
      last = await app.request(
        "/api/v2/users/lookup?username=nobody-here",
        { method: "GET", headers },
        env,
      )
      if (i < 60) expect(last.status).toBe(404)
    }
    expect(last?.status).toBe(429)
    expect(last?.headers.get("Retry-After")).toBeTruthy()
  })
})
