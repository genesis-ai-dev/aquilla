import { describe, it, expect } from "vitest"
import { withSecurityHeaders } from "./security-headers"

function apply(url: string, init?: ResponseInit): Response {
  return withSecurityHeaders(new Response("body", init), url)
}

describe("withSecurityHeaders", () => {
  it("sets the baseline headers on an https response", () => {
    const res = apply("https://aquilla.app/app")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'")
    expect(res.headers.get("Permissions-Policy")).toContain("camera=()")
  })

  it("keeps the microphone self-allowed — the app records cell audio", () => {
    const policy = apply("https://aquilla.app/").headers.get("Permissions-Policy") ?? ""
    expect(policy).toContain("microphone=(self)")
  })

  it("sets HSTS on https, without preload", () => {
    const hsts = apply("https://aquilla.app/").headers.get("Strict-Transport-Security")
    expect(hsts).toBe("max-age=31536000; includeSubDomains")
    expect(hsts).not.toContain("preload")
  })

  it.each([
    "http://localhost:5173/app",
    "http://127.0.0.1:8787/app",
    "http://dev.localhost:5173/app",
  ])("omits HSTS for local dev origin %s", (url) => {
    expect(apply(url).headers.get("Strict-Transport-Security")).toBeNull()
  })

  it("omits HSTS on plain http even for a public host", () => {
    expect(apply("http://aquilla.app/").headers.get("Strict-Transport-Security")).toBeNull()
  })

  it("preserves the original status, body, and unrelated headers", async () => {
    const res = withSecurityHeaders(
      new Response("hello", {
        status: 404,
        headers: { "Cache-Control": "public, max-age=0", "Content-Type": "text/html" },
      }),
      "https://aquilla.app/nope",
    )
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("hello")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0")
    expect(res.headers.get("Content-Type")).toBe("text/html")
  })

  it("overwrites a weaker upstream framing policy rather than deferring to it", () => {
    const res = withSecurityHeaders(
      new Response("body", { headers: { "X-Frame-Options": "SAMEORIGIN" } }),
      "https://aquilla.app/",
    )
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
  })
})
