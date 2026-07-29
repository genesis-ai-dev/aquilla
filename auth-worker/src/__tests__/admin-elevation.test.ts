// Step-up elevation for the admin console.
//
// Identity is by email: the base test allowlist is ADMIN_EMAILS=root@example.com
// (pg-test-env), so the seeded "root" user (root@example.com) is the admin. The
// emailed-code step-up turns on when ADMIN_REQUIRE_ELEVATION="true" (and not
// WRANGLER_LOCAL) — we flip it on per-suite and drive request → verify.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const me = (jwt: string) => app.request("/api/v2/admin/me", { headers: authHeader(jwt) }, env)
const overview = (jwt: string) =>
  app.request("/api/v2/admin/overview", { headers: authHeader(jwt) }, env)
const requestCode = (jwt: string) =>
  app.request("/api/v2/admin/elevation/request", { method: "POST", headers: authHeader(jwt) }, env)
const verifyCode = (jwt: string, code: string) =>
  app.request(
    "/api/v2/admin/elevation/verify",
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ code }) },
    env,
  )

beforeEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = "true"
})
afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
})

describe("admin identity is by email", () => {
  it("rejects a user whose account email is not in ADMIN_EMAILS (403)", async () => {
    await seedUser(1, "wendi") // wendi@example.com — not the admin email
    const res = await me(await jwtFor("wendi"))
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "platform admin required" })
  })
})

describe("step-up elevation flow", () => {
  it("an admin reaches /me but not the console before elevation", async () => {
    await seedUser(7, "root") // root@example.com — the admin email
    const jwt = await jwtFor("root")

    const meRes = await me(jwt)
    expect(meRes.status).toBe(200)
    expect((await meRes.json()) as Record<string, unknown>).toMatchObject({
      isPlatformAdmin: true,
      hardened: true,
      elevated: false,
    })

    const ov = await overview(jwt)
    expect(ov.status).toBe(403)
    expect((await ov.json()) as { error: string }).toMatchObject({ error: "elevation required" })
  })

  it("request → verify unlocks the console; /me flips to elevated", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")

    const reqRes = await requestCode(jwt)
    expect(reqRes.status).toBe(200)
    // No EMAIL binding in tests → the code comes back as devCode.
    const { devCode } = (await reqRes.json()) as { devCode?: string }
    expect(devCode).toMatch(/^\d{6}$/)

    const verifyRes = await verifyCode(jwt, devCode as string)
    expect(verifyRes.status).toBe(200)
    expect((await verifyRes.json()) as { elevated: boolean }).toMatchObject({ elevated: true })

    expect((await overview(jwt)).status).toBe(200)
    const meBody = (await (await me(jwt)).json()) as { elevated: boolean }
    expect(meBody.elevated).toBe(true)

    const audit = await env.AQUILLA_PG.prepare(
      "SELECT action FROM admin_audit_log WHERE user_id = 7 AND action = 'elevation.grant'",
    ).first<{ action: string }>()
    expect(audit?.action).toBe("elevation.grant")
  })

  it("rejects a wrong code (400)", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await requestCode(jwt)
    const res = await verifyCode(jwt, "000000")
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_code" })
  })

  it("codes are single-use — the same code can't be redeemed twice", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    const { devCode } = (await (await requestCode(jwt)).json()) as { devCode?: string }
    expect((await verifyCode(jwt, devCode as string)).status).toBe(200)
    expect((await verifyCode(jwt, devCode as string)).status).toBe(400)
  })

  it("rate-limits to 5 codes per hour (429 on the 6th)", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    for (let i = 0; i < 5; i++) {
      expect((await requestCode(jwt)).status).toBe(200)
    }
    expect((await requestCode(jwt)).status).toBe(429)
  })

  it("rate-limits repeated wrong-code guesses on /verify (429 after the cap)", async () => {
    // [Pen test] Auth & session mgmt (2026-07-27): verify previously had no
    // attempt limiting at all — a caller holding a valid (non-elevated) admin
    // JWT could brute-force the 6-digit code with unlimited guesses inside
    // its TTL. A wrong code must eventually 429 rather than keep 400ing.
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await requestCode(jwt)

    let sawRateLimited = false
    for (let i = 0; i < 15; i++) {
      const res = await verifyCode(jwt, "111111")
      if (res.status === 429) {
        sawRateLimited = true
        expect((await res.json()) as { error: string }).toMatchObject({ error: "rate_limited" })
        break
      }
      expect(res.status).toBe(400)
    }
    expect(sawRateLimited).toBe(true)
  })
})
