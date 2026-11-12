import { env } from "cloudflare:test"
import { expect, it } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { ANALYTICS_DISCLOSURE_VERSION, parseAnalyticsDecision } from "../../../shared/analytics-consent"
it("stores server-stamped consent for only the authenticated user and rejects stale or forged writes", async () => {
  await seedUser(1, "alice"); await seedUser(2, "bob")
  const url = "/api/v2/auth/me/analytics-consent"
  const a = authHeader(await jwtFor("alice")); const b = authHeader(await jwtFor("bob"))
  expect((await app.request(url, {}, env)).status).toBe(401)
  const put = (body: object) => app.request(url, { method: "PUT", headers: a, body: JSON.stringify(body) }, env)
  const choice = { allowed: true, source: "settings", disclosureVersion: ANALYTICS_DISCLOSURE_VERSION, expectedRevision: null }
  expect((await put({ ...choice, accountId: "2" })).status).toBe(400)
  const saved = await put(choice); expect(saved.status).toBe(200)
  const data = await saved.json() as { accountId: string; decision: unknown }
  expect(data.accountId).toBe("1"); const parsed = parseAnalyticsDecision(data.decision)
  expect(parsed?.allowed).toBe(true)
  expect((await put(choice)).status).toBe(409)
  const reserved = { "privacy.analytics.v1": { allowed: true } }
  for (const [path, body] of [["/me", { preferences: reserved }], ["/me/preferences", { set: reserved }], ["/me/preferences", { setIfAbsent: reserved }]] as const) {
    expect((await app.request(`/api/v2/auth${path}`, { method: "PATCH", headers: a, body: JSON.stringify(body) }, env)).status).toBe(400)
  }
  expect((await app.request("/api/v2/auth/me", { method: "PATCH", headers: a, body: JSON.stringify({ preferences: { theme: "dark" } }) }, env)).status).toBe(200)
  expect(await (await app.request(url, { headers: a }, env)).json()).toEqual(data)
  expect(await (await app.request(url, { headers: b }, env)).json()).toEqual({ accountId: "2", decision: null })
  expect((await put({ ...choice, allowed: false, expectedRevision: parsed?.revision })).status).toBe(200)
})
