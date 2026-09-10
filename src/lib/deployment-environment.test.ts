import { describe, it, expect } from "vitest"
import {
  apiHostname,
  classifyApiHost,
  resolveBackendEnvironment,
} from "./deployment-environment"
import { AUTH_API_URL } from "@/lib/sync/sync-token"
import { SYNC_WORKER_HOST } from "@/lib/sync/sync-worker-host"

describe("apiHostname", () => {
  it("strips scheme, path, credentials and port", () => {
    expect(apiHostname("https://api.aquilla.app/identity")).toBe("api.aquilla.app")
    expect(apiHostname("api.dev.aquilla.app/sync")).toBe("api.dev.aquilla.app")
    expect(apiHostname("127.0.0.1:8787")).toBe("127.0.0.1")
    expect(apiHostname("wss://api.aquilla.app/sync/ws?projectId=1")).toBe("api.aquilla.app")
    expect(apiHostname("https://user:pass@api.aquilla.app")).toBe("api.aquilla.app")
    expect(apiHostname("HTTPS://API.Aquilla.App/")).toBe("api.aquilla.app")
    expect(apiHostname("api.aquilla.app.")).toBe("api.aquilla.app")
  })

  it("keeps IPv6 literals intact", () => {
    expect(apiHostname("http://[::1]:8787/sync")).toBe("[::1]")
    expect(apiHostname("::1")).toBe("::1")
  })

  it("returns an empty host for an empty base", () => {
    expect(apiHostname("")).toBe("")
    expect(apiHostname("   ")).toBe("")
  })
})

describe("classifyApiHost", () => {
  it("recognizes the production API host and nothing else", () => {
    expect(classifyApiHost("https://api.aquilla.app/identity")).toBe("production")
    expect(classifyApiHost("api.aquilla.app/sync")).toBe("production")
  })

  it("recognizes the development API host", () => {
    expect(classifyApiHost("https://api.dev.aquilla.app/identity")).toBe("development")
    expect(classifyApiHost("api.dev.aquilla.app/sync")).toBe("development")
  })

  it("recognizes local dev-stack hosts", () => {
    expect(classifyApiHost("127.0.0.1:8787")).toBe("local")
    expect(classifyApiHost("http://localhost:5173")).toBe("local")
    expect(classifyApiHost("http://[::1]:8787")).toBe("local")
    expect(classifyApiHost("http://aquilla.local")).toBe("local")
  })

  it("recognizes route-free Workers Builds previews", () => {
    expect(classifyApiHost("https://aquilla-web-preview.frontier.workers.dev")).toBe(
      "preview",
    )
  })

  it("never guesses production for an unrecognized or empty host", () => {
    expect(classifyApiHost("https://api.staging.aquilla.app")).toBe("unknown")
    // Lookalike hosts must not slip through as production.
    expect(classifyApiHost("https://api.aquilla.app.evil.test")).toBe("unknown")
    expect(classifyApiHost("https://aquilla.app")).toBe("unknown")
    expect(classifyApiHost("")).toBe("unknown")
  })
})

describe("resolveBackendEnvironment", () => {
  it("is production only when both API hosts are production", () => {
    expect(
      resolveBackendEnvironment(
        "https://api.aquilla.app/identity",
        "api.aquilla.app/sync",
      ),
    ).toEqual({ kind: "production", isProduction: true, host: "api.aquilla.app" })
  })

  it("flags the development backend and names its host", () => {
    expect(
      resolveBackendEnvironment(
        "https://api.dev.aquilla.app/identity",
        "api.dev.aquilla.app/sync",
      ),
    ).toEqual({
      kind: "development",
      isProduction: false,
      host: "api.dev.aquilla.app",
    })
  })

  it("flags a local dev stack", () => {
    const env = resolveBackendEnvironment("http://127.0.0.1:8788", "127.0.0.1:8787")
    expect(env.kind).toBe("local")
    expect(env.isProduction).toBe(false)
  })

  it("reports the louder half of a mixed build, in either order", () => {
    const authProd = resolveBackendEnvironment(
      "https://api.aquilla.app/identity",
      "api.dev.aquilla.app/sync",
    )
    expect(authProd).toEqual({
      kind: "development",
      isProduction: false,
      host: "api.dev.aquilla.app",
    })

    const syncProd = resolveBackendEnvironment(
      "https://api.dev.aquilla.app/identity",
      "api.aquilla.app/sync",
    )
    expect(syncProd.kind).toBe("development")
    expect(syncProd.isProduction).toBe(false)
  })

  it("defaults to the same bases the sync modules actually call", () => {
    // Drift guard: this module re-reads the build-time vars instead of
    // importing AUTH_API_URL / SYNC_WORKER_HOST (they get vi.mocked by
    // component tests). If their fallbacks change, the copy here must too.
    expect(resolveBackendEnvironment()).toEqual(
      resolveBackendEnvironment(AUTH_API_URL, SYNC_WORKER_HOST),
    )
  })

  it("treats an unknown host as the loudest signal of all", () => {
    const env = resolveBackendEnvironment(
      "https://api.somewhere-else.test/identity",
      "api.aquilla.app/sync",
    )
    expect(env.kind).toBe("unknown")
    expect(env.isProduction).toBe(false)
    expect(env.host).toBe("api.somewhere-else.test")
  })
})
