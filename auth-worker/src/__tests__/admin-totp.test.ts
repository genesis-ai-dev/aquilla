import { env } from "cloudflare:test"
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { base32, totp, matchingStep, deployment } from "../lib/admin-totp"
let jwt: string
const call = (path: string, body?: object, token = jwt) =>
  app.request(
    `/api/v2/admin/${path}`,
    {
      method: body ? "POST" : "GET",
      headers: authHeader(token),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  )
async function email() {
  const r = await call("elevation/request", {})
  expect(r.status).toBe(200)
  const { devCode } = (await r.json()) as { devCode: string }
  expect((await call("elevation/verify", { code: devCode })).status).toBe(200)
  return devCode
}
async function setup() {
  await email()
  const r = await call("totp/setup", {})
  expect(r.status).toBe(200)
  return (await r.json()) as { generation: string; secret: string; uri: string }
}
async function enroll() {
  const s = await setup()
  const r = await call("totp/confirm", {
    generation: s.generation,
    code: await totp(s.secret, Math.floor(Date.now() / 30000)),
  })
  expect(r.status).toBe(200)
  const { recoveryCodes } = (await r.json()) as { recoveryCodes: string[] }
  expect(
    (
      await call("totp/complete", {
        savedRecoveryCodes: true,
        generation: s.generation,
      })
    ).status,
  ).toBe(200)
  return { ...s, recoveryCodes }
}
beforeEach(async () => {
  // Keep replay assertions within one TOTP step, independent of wall-clock boundaries.
  vi.spyOn(Date, "now").mockReturnValue(Date.now())
  env.ADMIN_REQUIRE_ELEVATION = "true"
  env.ADMIN_TOTP_KEY = "test-only-unique-encryption-material-123456789"
  env.DEPLOYMENT_WORKER_NAME = "totp-test"
  await seedUser(7, "root")
  jwt = await jwtFor("root")
})
afterEach(() => {
  vi.restoreAllMocks()
  delete env.ADMIN_REQUIRE_ELEVATION
  delete env.ADMIN_TOTP_KEY
  delete env.DEPLOYMENT_WORKER_NAME
})
describe("admin authenticator", () => {
  it("matches RFC 6238 SHA1 vectors (six digit truncation)", async () => {
    const secret = base32(new TextEncoder().encode("12345678901234567890"))
    for (const [time, code] of [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ] as const)
      expect(await totp(secret, Math.floor(time / 30))).toBe(code)
  })
  it("keeps email until confirmed setup and recovery acknowledgment; then rejects email and old grants", async () => {
    expect((await call("totp/setup", {})).status).toBe(403)
    const s = await setup()
    await email()
    expect(
      (
        await call("totp/complete", {
          savedRecoveryCodes: true,
          generation: s.generation,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call("totp/confirm", {
          generation: s.generation,
          code: "invalid",
        })
      ).status,
    ).toBe(400)
    const confirm = await call("totp/confirm", {
      generation: s.generation,
      code: await totp(s.secret, Math.floor(Date.now() / 30000)),
    })
    expect(confirm.status).toBe(200)
    await email()
    expect(
      (
        await call("totp/complete", {
          savedRecoveryCodes: false,
          generation: s.generation,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call("totp/complete", {
          savedRecoveryCodes: true,
          generation: s.generation,
        })
      ).status,
    ).toBe(200)
    expect((await call("elevation/request", {})).status).toBe(409)
    expect((await call("elevation/verify", { code: "123456" })).status).toBe(
      409,
    )
    expect(await (await call("me")).json()).toMatchObject({
      elevated: false,
      totpEnabled: true,
    })
  })
  it("atomically consumes recovery codes and scopes grants to the redeeming session", async () => {
    const s = await enroll()
    env.ADMIN_REQUIRE_ELEVATION = "false"
    expect(await (await call("me")).json()).toMatchObject({ elevated: false, hardened: true })
    const other = await jwtFor("root", Math.floor(Date.now() / 1000) - 600)
    const results = await Promise.all([
      call("totp/verify", { code: s.recoveryCodes[0], recovery: true }),
      call("totp/verify", { code: s.recoveryCodes[0], recovery: true }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 400])
    expect(await (await call("me")).json()).toMatchObject({ elevated: true })
    expect(await (await call("me", undefined, other)).json()).toMatchObject({
      elevated: false,
    })
    expect(
      (
        await call("totp/verify", {
          code: await totp(s.secret, Math.floor(Date.now() / 30000)),
        })
      ).status,
    ).toBe(400)
    const future = await totp(s.secret, Math.floor(Date.now() / 30000) + 1)
    const attempts = await Promise.all([
      call("totp/verify", { code: future }),
      call("totp/verify", { code: future }),
    ])
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 400])
  })
  it("protects setup by session, expiry, and account; stores no plaintext secrets or recovery codes", async () => {
    const s = await setup()
    const other = await jwtFor("root", Math.floor(Date.now() / 1000) - 600)
    const code = await totp(s.secret, Math.floor(Date.now() / 30000))
    expect(
      (await call("totp/confirm", { generation: s.generation, code }, other))
        .status,
    ).toBe(400)
    await seedUser(8, "other")
    expect((await call("totp/setup", {}, await jwtFor("other"))).status).toBe(
      403,
    )
    const r = await call("totp/confirm", { generation: s.generation, code })
    const data = (await r.json()) as { recoveryCodes: string[] }
    const row = await env.AQUILLA_PG.prepare("SELECT * FROM admin_totp").first()
    expect(JSON.stringify(row)).not.toContain(s.secret)
    for (const recovery of data.recoveryCodes)
      expect(JSON.stringify(row)).not.toContain(recovery)
    await env.AQUILLA_PG.prepare(
      "UPDATE admin_totp SET expires_at=now()-interval '1 second'",
    ).run()
    expect(
      (
        await call("totp/complete", {
          savedRecoveryCodes: true,
          generation: s.generation,
        })
      ).status,
    ).toBe(400)
    await email()
  })
  it("fails closed without its key, isolates deployments, and requires proof to disable", async () => {
    const s = await enroll()
    delete env.ADMIN_TOTP_KEY
    expect(
      (await call("totp/verify", { code: s.recoveryCodes[0], recovery: true }))
        .status,
    ).toBe(503)
    expect((await call("elevation/request", {})).status).toBe(409)
    env.ADMIN_TOTP_KEY = "test-only-unique-encryption-material-123456789"
    env.DEPLOYMENT_WORKER_NAME = "other-deployment"
    expect(await (await call("totp")).json()).toMatchObject({ enabled: false })
    env.DEPLOYMENT_WORKER_NAME = "totp-test"
    expect(
      (
        await call("totp/verify", {
          code: "invalid",
          disable: true,
          recovery: true,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call("totp/verify", {
          code: s.recoveryCodes[0],
          disable: true,
          recovery: true,
        })
      ).status,
    ).toBe(200)
    expect(await (await call("totp")).json()).toMatchObject({ enabled: false })
    expect(await (await call("me")).json()).toMatchObject({ elevated: false })
    expect((await call("elevation/request", {})).status).toBe(200)
  })
  it("rejects stale setup acknowledgments and codes outside the clock window", async () => {
    const first = await setup()
    const secondResponse = await call("totp/setup", {})
    const second = (await secondResponse.json()) as {
      generation: string
      secret: string
    }
    expect(
      (
        await call("totp/confirm", {
          generation: first.generation,
          code: await totp(first.secret, Math.floor(Date.now() / 30000)),
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call("totp/confirm", {
          generation: second.generation,
          code: await totp(second.secret, Math.floor(Date.now() / 30000)),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await call("totp/complete", {
          savedRecoveryCodes: true,
          generation: first.generation,
        })
      ).status,
    ).toBe(400)
    expect(await (await call("totp")).json()).toMatchObject({ enabled: false })
    expect(
      (
        await call("totp/complete", {
          savedRecoveryCodes: true,
          generation: second.generation,
        })
      ).status,
    ).toBe(200)
    const time = 1234567890000
    expect(
      await matchingStep(
        second.secret,
        await totp(second.secret, Math.floor(time / 30000) - 2),
        time,
      ),
    ).toBeNull()
  })
  it("isolates sibling previews sharing a Worker parent", () => {
    const context = (url: string) => ({ env: { DEPLOYMENT_WORKER_NAME: "aquilla-auth-preview", BASE_URL: url } }) as Parameters<typeof deployment>[0]
    expect(deployment(context("https://branch-a.example"))).not.toBe(deployment(context("https://branch-b.example")))
    expect(deployment(context("https://branch-a.example/path"))).toBe(deployment(context("https://branch-a.example")))
  })
  it("limits attempts even with a valid admin session", async () => {
    const s = await enroll()
    for (let i = 0; i < 7; i++)
      await call("totp/verify", { code: "invalid", recovery: true })
    expect(
      (await call("totp/verify", { code: s.recoveryCodes[0], recovery: true }))
        .status,
    ).toBe(429)
  })
})
