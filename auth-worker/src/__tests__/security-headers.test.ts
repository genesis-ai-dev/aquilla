// [Pen test] API security & data exposure: every response carries the baseline
// hardening headers; a route's own Cache-Control wins over the no-store default.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"

describe("baseline response headers", () => {
  it("sets nosniff, no-referrer and no-store on API responses", async () => {
    const res = await app.request("/api/v2/health", {}, env)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("keeps CORS headers alongside", async () => {
    const res = await app.request("/api/v2/health", {}, env)
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("hardens error responses too", async () => {
    const res = await app.request("/api/v2/users/does-not-exist", {}, env)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })
})
