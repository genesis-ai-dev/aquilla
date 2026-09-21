// Step-up elevation for the admin console.
//
// Identity is by email: the base test allowlist is ADMIN_EMAILS=root@example.com
// (pg-test-env), so the seeded "root" user (root@example.com) is the admin. The
// emailed-code step-up turns on when ADMIN_REQUIRE_ELEVATION="true" (and not
// WRANGLER_LOCAL) — we flip it on per-suite and drive request → verify.

import { env } from "cloudflare:test"
import { sign } from "hono/jwt"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/** A second, DIFFERENT credential for the same account. `jwtFor` is keyed by
 *  (sub, iat), so backdating `iat` by a second is enough to get a distinct
 *  token — and, like `jwtFor`, it carries no `jti`, which exercises
 *  `sessionCacheKey`'s `tok:<sha256>` fallback arm. */
const secondJwtFor = (username: string) =>
  jwtFor(username, Math.floor(Date.now() / 1000) - 1)

/** A token carrying an explicit `jti`, exercising the `jti:` arm instead. */
const jwtWithJti = async (username: string, jti: string) => {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: username, iat: now, exp: now + 3600, jti }, env.SECRET_KEY, "HS256")
}

/** Drive request -> verify to completion on one token. */
const elevate = async (jwt: string) => {
  const { devCode } = (await (await requestCode(jwt)).json()) as { devCode?: string }
  const res = await verifyCode(jwt, devCode as string)
  expect(res.status).toBe(200)
  return devCode as string
}

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

// ── OPS-35 (2026-09-21): elevation is bound to the session, not the account ──
//
// The gate exists to stop a caller who already holds a valid but NON-elevated
// admin JWT — /verify's own brute-force comment says so. Keyed on user_id
// alone, the real operator's elevation silently elevated that caller too.
describe("OPS-35 — elevation binds to the credential that redeemed the code", () => {
  it("does not elevate a second token for the same admin", async () => {
    await seedUser(7, "root")
    const operator = await jwtFor("root")
    const stolen = await secondJwtFor("root")

    // Both are live sessions for the same platform admin, neither elevated.
    expect((await overview(operator)).status).toBe(403)
    expect((await overview(stolen)).status).toBe(403)

    await elevate(operator)

    // The operator's own session is in.
    expect((await overview(operator)).status).toBe(200)

    // The other credential must NOT ride along on that grant.
    const res = await overview(stolen)
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "elevation required" })

    // ...and /me must agree with the gate rather than reporting a phantom
    // elevation the console would then 403 on.
    const meBody = (await (await me(stolen)).json()) as { elevated: boolean }
    expect(meBody.elevated).toBe(false)
  })

  it("binds by jti when the token carries one", async () => {
    await seedUser(7, "root")
    const a = await jwtWithJti("root", "11111111-1111-4111-8111-111111111111")
    const b = await jwtWithJti("root", "22222222-2222-4222-8222-222222222222")

    await elevate(a)
    expect((await overview(a)).status).toBe(200)
    expect((await overview(b)).status).toBe(403)
  })

  it("lets one operator hold elevation in two sessions at once", async () => {
    // Per-session rows, so a second elevation must not de-elevate the first
    // (the old ON CONFLICT (user_id) upsert would have).
    await seedUser(7, "root")
    const first = await jwtFor("root")
    const second = await secondJwtFor("root")

    await elevate(first)
    await elevate(second)

    expect((await overview(first)).status).toBe(200)
    expect((await overview(second)).status).toBe(200)

    const rows = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM admin_elevations WHERE user_id = 7",
    ).first<{ n: number }>()
    expect(Number(rows?.n)).toBe(2)
  })
})

// ── OPS-36 (2026-09-21): the emailed code is not readable at rest ────────────
describe("OPS-36 — elevation codes are hashed at rest", () => {
  it("stores a scrypt digest and never the code itself", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    const { devCode } = (await (await requestCode(jwt)).json()) as { devCode?: string }
    expect(devCode).toMatch(/^\d{6}$/)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT code, code_hash FROM admin_elevation_codes WHERE user_id = 7",
    ).first<{ code: string | null; code_hash: string | null }>()

    // The retired plaintext column must not be written any more...
    expect(row?.code).toBeNull()
    // ...and the digest must be a real scrypt hash that does not contain the
    // code in the clear.
    expect(row?.code_hash).toMatch(/^scrypt:\d+:\d+:\d+\$/)
    expect(row?.code_hash).not.toContain(devCode as string)
  })

  it("a hashed code still verifies end to end", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await elevate(jwt)
    expect((await overview(jwt)).status).toBe(200)
  })

  it("ignores a legacy plaintext-only row (no code_hash) rather than accepting it", async () => {
    // Rows written by pre-0094 code during the deploy window carry `code` but
    // no `code_hash`. They must read as "no such code", not as a match.
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO admin_elevation_codes (user_id, code, expires_at)
       VALUES (?, ?, now() + interval '10 minutes')`,
    )
      .bind(7, "654321")
      .run()

    const res = await verifyCode(jwt, "654321")
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_code" })
  })
})
