import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, expect } from "vitest"
import worker from "./index"
import {
  ENFORCED_CSP,
  REPORT_ONLY_CSP,
  SECURITY_HEADERS,
  withSecurityHeaders,
} from "./security-headers"

/** Parse `public/_headers` into the header map declared for the `/*` rule. */
function parsePublicHeaders(): Record<string, string> {
  const raw = readFileSync(resolve(__dirname, "../public/_headers"), "utf8")
  const out: Record<string, string> = {}
  let inGlobRule = false
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      inGlobRule = line.trim() === "/*"
      continue
    }
    if (!inGlobRule) continue
    const idx = line.indexOf(":")
    if (idx === -1) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function makeEnv() {
  return {
    ASSETS: {
      fetch: async (req: Request | string): Promise<Response> => {
        const url = new URL(typeof req === "string" ? req : req.url)
        return new Response(`served:${url.pathname}`, {
          headers: { "Content-Type": "text/html" },
        })
      },
    },
  }
}

describe("withSecurityHeaders", () => {
  it("applies every baseline header", () => {
    const out = withSecurityHeaders(new Response("hi"))
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(out.headers.get(name)).toBe(value)
    }
  })

  it("preserves status and pre-existing unrelated headers", async () => {
    const src = new Response("body", {
      status: 201,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    })
    const out = withSecurityHeaders(src)
    expect(out.status).toBe(201)
    expect(out.headers.get("Cache-Control")).toBe("no-store")
    expect(await out.text()).toBe("body")
  })

  it("overwrites a weaker upstream value rather than appending", () => {
    const src = new Response("x", { headers: { "X-Frame-Options": "ALLOWALL" } })
    expect(withSecurityHeaders(src).headers.get("X-Frame-Options")).toBe("DENY")
  })

  // Cloning a 204/304 with a body throws — the asset router can return these
  // for conditional requests, so the null-body path must be handled.
  it.each([204, 304])("clones null-body status %i without throwing", (status) => {
    const out = withSecurityHeaders(new Response(null, { status }))
    expect(out.status).toBe(status)
    expect(out.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })
})

describe("policy shape", () => {
  it("enforces only frame-ancestors, so no working feature breaks on deploy", () => {
    expect(ENFORCED_CSP).toBe("frame-ancestors 'none'")
  })

  it("ships the full policy as Report-Only, not enforced", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy-Report-Only"]).toBe(REPORT_ONLY_CSP)
    expect(SECURITY_HEADERS["Content-Security-Policy"]).not.toContain("default-src")
  })

  it("keeps microphone and autoplay usable — audio capture and TTS depend on them", () => {
    const pp = SECURITY_HEADERS["Permissions-Policy"]
    expect(pp).toContain("microphone=(self)")
    expect(pp).toContain("autoplay=(self)")
    expect(pp).toContain("camera=()")
  })

  it("allows the origins the SPA actually calls", () => {
    for (const origin of [
      "https://*.aquilla.app",
      "wss://*.aquilla.app",
      "https://generativelanguage.googleapis.com",
      "https://*.posthog.com",
      "https://*.modal.run",
    ]) {
      expect(REPORT_ONLY_CSP).toContain(origin)
    }
  })

  // OrgSettingsMonday opens its OAuth popup without `noopener` on purpose,
  // because it needs the handle to navigate it. COOP severs that browsing
  // context group once the popup goes cross-origin. Don't re-add this header
  // without driving the real flow in a browser first.
  it("does not set Cross-Origin-Opener-Policy — it endangers the Monday OAuth popup", () => {
    expect(SECURITY_HEADERS["Cross-Origin-Opener-Policy"]).toBeUndefined()
  })

  it("allows wasm and blob workers — onnxruntime/whisper need both", () => {
    expect(REPORT_ONLY_CSP).toContain("'wasm-unsafe-eval'")
    expect(REPORT_ONLY_CSP).toContain("worker-src 'self' blob:")
  })
})

// `run_worker_first = ["/"]` means these two files cover disjoint sets of
// paths. If they drift, part of the site silently loses its headers.
describe("public/_headers parity with the Worker", () => {
  it("declares exactly the same headers and values", () => {
    expect(parsePublicHeaders()).toEqual({ ...SECURITY_HEADERS })
  })
})

describe("worker responses", () => {
  it("sets security headers on the root marketing page", async () => {
    const res = await worker.fetch(new Request("https://aquilla.app/"), makeEnv())
    expect(res.headers.get("Content-Security-Policy")).toBe(ENFORCED_CSP)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    // The existing cache policy must survive the header pass.
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600")
  })

  it("keeps X-Robots-Tag on non-canonical hosts alongside the new headers", async () => {
    const res = await worker.fetch(new Request("https://dev.aquilla.app/"), makeEnv())
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex")
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
  })

  it("does not set X-Robots-Tag on the canonical host", async () => {
    const res = await worker.fetch(new Request("https://aquilla.app/beta"), makeEnv())
    expect(res.headers.get("X-Robots-Tag")).toBeNull()
    expect(res.headers.get("X-Frame-Options")).toBe("DENY")
  })
})
