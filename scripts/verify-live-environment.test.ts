import { describe, expect, it, vi } from "vitest"
import { verifyLiveEnvironment } from "./verify-live-environment.mjs"

const lookup = vi.fn(async () => [{ address: "203.0.113.10", family: 4 }])

function response(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  })
}

function healthyApiFetch(host: string) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `https://${host}/identity/api/v2/health`) {
      return response(JSON.stringify({ ok: true, name: "aquilla-identity" }), 200, "application/json")
    }
    if (url === `https://${host}/chat/api/v1/chat/completions`) {
      return response(JSON.stringify({ error: "Authorization header required" }), 401, "application/json")
    }
    if (url === `https://${host}/sync/events`) {
      return response("missing Authorization header", 401)
    }
    throw new Error(`unexpected URL ${url}`)
  })
}

describe("live deployment environment verification", () => {
  it("verifies the staging identity, chat, and sync route contracts", async () => {
    const fetchImpl = healthyApiFetch("api.staging.aquilla.app")

    await expect(verifyLiveEnvironment("staging", {
      surface: "auth",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()

    await expect(verifyLiveEnvironment("staging", {
      surface: "sync",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()
  })

  it("rejects a 401 that did not come from the sync Worker guard", async () => {
    const fetchImpl = vi.fn(async () => response("wrong worker", 401))

    await expect(verifyLiveEnvironment("production", {
      surface: "sync",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).rejects.toThrow("unexpected body")
  })

  it("verifies that staging SPA assets contain staging targets and no dev targets", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      // The bare origin serves the marketing homepage, whose JS graph lacks
      // the sync/chat targets (AQU-779) — the verifier must crawl /app instead.
      if (url === "https://staging.aquilla.app" || url === "https://staging.aquilla.app/") {
        return response('<script type="module" src="/assets/homepage.js"></script>', 200, "text/html")
      }
      if (url === "https://staging.aquilla.app/assets/homepage.js") {
        return response('"https://api.staging.aquilla.app/identity"')
      }
      if (url === "https://staging.aquilla.app/app") {
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      if (url === "https://staging.aquilla.app/assets/index.js") {
        return response('const deps = ["assets/chunk.js"]; import "./chunk.js"')
      }
      if (url === "https://staging.aquilla.app/assets/chunk.js") {
        return response([
          "https://api.staging.aquilla.app/identity",
          "api.staging.aquilla.app/sync",
          "https://api.staging.aquilla.app/chat",
        ].join(" "))
      }
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(verifyLiveEnvironment("staging", {
      surface: "spa",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()
  })

  it("rejects a staging bundle that also contains a development target", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://staging.aquilla.app/app") {
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      return response([
        "https://api.staging.aquilla.app/identity",
        "api.staging.aquilla.app/sync",
        "https://api.staging.aquilla.app/chat",
        "https://api.dev.aquilla.app/identity",
      ].join(" "))
    })

    await expect(verifyLiveEnvironment("staging", {
      surface: "spa",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).rejects.toThrow("cross-environment hosts: api.dev.aquilla.app")
  })

  it("fails closed for unknown environments and surfaces", async () => {
    await expect(verifyLiveEnvironment("prod", { log: vi.fn() }))
      .rejects.toThrow("unknown environment")
    await expect(verifyLiveEnvironment("production", { surface: "worker" as never, log: vi.fn() }))
      .rejects.toThrow("unknown surface")
  })
})
