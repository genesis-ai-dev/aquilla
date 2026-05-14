import { describe, it, expect } from "vitest"
import { handleCorsPreflight, withCors, isBrowserCorsPath } from "../cors"

const ORIGIN = "https://app.example.com"

function req(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://sync.example.com${path}`, {
    method,
    headers: { Origin: ORIGIN, ...headers },
  })
}

describe("isBrowserCorsPath", () => {
  it("matches the exact /events path", () => {
    expect(isBrowserCorsPath("/events")).toBe(true)
  })

  it("matches /cells/audit-stats under the /cells/ prefix", () => {
    expect(isBrowserCorsPath("/cells/audit-stats")).toBe(true)
  })

  it("matches /cell-validators exactly", () => {
    expect(isBrowserCorsPath("/cell-validators")).toBe(true)
  })

  it("matches the project read API namespace", () => {
    expect(isBrowserCorsPath("/api/v1/projects/p1/files/f1/cells")).toBe(true)
    expect(isBrowserCorsPath("/api/v1/projects/p1/files/f1/stale-source")).toBe(true)
  })

  it("does not match admin paths", () => {
    expect(isBrowserCorsPath("/admin/projects/p1/archive")).toBe(false)
  })

  it("does not match a partyserver party path", () => {
    expect(isBrowserCorsPath("/parties/file-sync/proj-a:file-x")).toBe(false)
  })
})

describe("handleCorsPreflight", () => {
  it("returns 204 with CORS headers for OPTIONS on a browser path", () => {
    const res = handleCorsPreflight(req("OPTIONS", "/events"))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(204)
    expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(res!.headers.get("Access-Control-Allow-Methods")).toContain("POST")
    expect(res!.headers.get("Access-Control-Allow-Headers")).toContain("Authorization")
  })

  it("returns 204 for OPTIONS on /cells/audit-stats", () => {
    const res = handleCorsPreflight(req("OPTIONS", "/cells/audit-stats?fileId=abc"))
    expect(res?.status).toBe(204)
  })

  it("returns 204 for OPTIONS on the project read API", () => {
    const res = handleCorsPreflight(req("OPTIONS", "/api/v1/projects/p1/files/f1/cells"))
    expect(res?.status).toBe(204)
  })

  it("returns null for non-OPTIONS methods so dispatch continues", () => {
    expect(handleCorsPreflight(req("GET", "/events"))).toBeNull()
    expect(handleCorsPreflight(req("POST", "/events"))).toBeNull()
  })

  it("returns null for OPTIONS on non-browser paths so partyserver/admin are untouched", () => {
    expect(handleCorsPreflight(req("OPTIONS", "/admin/files/p1/f1/compact-doc"))).toBeNull()
    expect(handleCorsPreflight(req("OPTIONS", "/parties/file-sync/proj-a:file-x"))).toBeNull()
  })
})

describe("withCors", () => {
  it("adds Access-Control-Allow-Origin to a browser-path response", () => {
    const r = req("GET", "/events?fileId=abc")
    const wrapped = withCors(new Response("ok", { status: 200 }), r)
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(wrapped.headers.get("Vary")).toBe("Origin")
  })

  it("preserves status, statusText, and existing body content", async () => {
    const r = req("POST", "/events")
    const wrapped = withCors(
      new Response("payload", { status: 207, statusText: "Multi-Status" }),
      r,
    )
    expect(wrapped.status).toBe(207)
    expect(wrapped.statusText).toBe("Multi-Status")
    expect(await wrapped.text()).toBe("payload")
  })

  it("preserves arbitrary existing headers (e.g. Content-Type) on the response", () => {
    const r = req("GET", "/cells/audit-stats?fileId=abc")
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Trace-Id": "abc-123" },
    })
    const wrapped = withCors(original, r)
    expect(wrapped.headers.get("Content-Type")).toBe("application/json")
    expect(wrapped.headers.get("X-Trace-Id")).toBe("abc-123")
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("*")
  })

  it("is a no-op for admin paths so server-to-server responses are unchanged", () => {
    const r = req("POST", "/admin/projects/p1/archive")
    const original = new Response("ok", { status: 200 })
    const wrapped = withCors(original, r)
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBeNull()
  })
})
