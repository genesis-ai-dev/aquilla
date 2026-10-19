// Why this matters: the API Workers read every secret as `env.<NAME>`. The
// overlay lets ops change a secret in Cloudflare Secrets Store without a new
// Worker version (which the environment guard would reject), while the
// per-Worker secret stays a working fallback if the beta store misbehaves.
// A regression here either serves a stale/empty secret (auth breaks) or makes
// a store outage take the API down — both worse than not having the store.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CACHE_TTL_MS, __resetStoreSecretCacheForTests, withStoreSecrets,
} from "./secrets-store-overlay"

const store = (value: string | (() => Promise<string>)) => ({
  get: vi.fn(typeof value === "string" ? async () => value : value),
})

afterEach(() => {
  __resetStoreSecretCacheForTests()
  vi.restoreAllMocks()
})

describe("withStoreSecrets", () => {
  it("returns env untouched when no Secrets Store binding exists, so Workers without the store pay nothing", async () => {
    const env = { SECRET_KEY: "worker", ENVIRONMENT: "production" }
    expect(await withStoreSecrets(env)).toBe(env)
  })

  it("lets the store value win over the Worker secret of the same name", async () => {
    const env = { SYNC_SECRET_KEY: "from-worker", SS_SYNC_SECRET_KEY: store("from-store") }
    const out = await withStoreSecrets(env)
    expect(out.SYNC_SECRET_KEY).toBe("from-store")
    expect(env.SYNC_SECRET_KEY).toBe("from-worker") // the runtime env is not mutated
  })

  it("supplies a secret that exists only in the store (no Worker secret needed to add one)", async () => {
    const env: Record<string, unknown> = { SS_OMNI_SHARED_SECRET: store("omni") }
    expect((await withStoreSecrets(env)).OMNI_SHARED_SECRET).toBe("omni")
  })

  it("falls back to the Worker secret when the store read fails, instead of failing the request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = { SECRET_KEY: "worker", SS_SECRET_KEY: store(async () => { throw new Error("beta outage") }) }
    expect((await withStoreSecrets(env)).SECRET_KEY).toBe("worker")
  })

  it("never replaces a Worker secret with an empty store value", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = { SECRET_KEY: "worker", SS_SECRET_KEY: store("") }
    expect((await withStoreSecrets(env)).SECRET_KEY).toBe("worker")
  })

  it("picks up a changed store value once the cache expires — the point of the store", async () => {
    let value = "v1"
    const binding = store(async () => value)
    const env = { SS_OPENROUTER_API_KEY: binding } as Record<string, unknown>
    expect((await withStoreSecrets(env, 0)).OPENROUTER_API_KEY).toBe("v1")
    value = "v2"
    expect((await withStoreSecrets(env, CACHE_TTL_MS - 1)).OPENROUTER_API_KEY).toBe("v1")
    expect((await withStoreSecrets(env, CACHE_TTL_MS + 1)).OPENROUTER_API_KEY).toBe("v2")
    expect(binding.get).toHaveBeenCalledTimes(2)
  })

  it("keeps serving the last good store value if a refresh fails mid-rotation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    let fail = false
    const binding = store(async () => { if (fail) throw new Error("down"); return "rotated" })
    const env = { SECRET_KEY: "old-worker-value", SS_SECRET_KEY: binding }
    expect((await withStoreSecrets(env, 0)).SECRET_KEY).toBe("rotated")
    fail = true
    expect((await withStoreSecrets(env, CACHE_TTL_MS + 1)).SECRET_KEY).toBe("rotated")
  })

  it("ignores SS_ names that are not Secrets Store bindings", async () => {
    const env = { SS_NOTE: "plain text var", SECRET_KEY: "worker" }
    expect(await withStoreSecrets(env)).toBe(env)
  })
})
