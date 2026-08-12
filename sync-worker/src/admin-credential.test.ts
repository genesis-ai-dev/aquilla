import { describe, expect, it } from "vitest"
import { adminCredential, handleAdminRequest, type AdminEnv } from "./admin"

// OPS-2 of docs/OPSEC-REVIEW-2026-08-10.md: /admin/* accepted the token-signing
// key as a plaintext bearer, so exercising an admin route put a key that mints
// tokens for any project into shell history. These tests pin the migration
// behaviour — dedicated secret preferred, shared key still accepted so the
// change can deploy before the secret is provisioned.

const noopBucket = {
  list: async () => ({ objects: [], truncated: false as const }),
  delete: async () => {},
} as unknown as R2Bucket

const envWith = (over: Partial<AdminEnv> = {}): AdminEnv => ({
  SNAPSHOTS: noopBucket,
  ...over,
})

const del = (auth?: string) =>
  new Request("https://sync.example/admin/files/p1/f1", {
    method: "DELETE",
    headers: auth ? { Authorization: auth } : {},
  })

describe("adminCredential", () => {
  it("prefers the dedicated admin secret", () => {
    const result = adminCredential({ ADMIN_SECRET: "dedicated", SYNC_SECRET_KEY: "signing" })
    expect(result).toEqual({ secret: "dedicated", source: "admin-secret" })
  })

  it("falls back to the signing key while ADMIN_SECRET is unprovisioned", () => {
    const result = adminCredential({ SYNC_SECRET_KEY: "signing" })
    expect(result).toEqual({ secret: "signing", source: "sync-secret-key-fallback" })
  })

  it("ignores an empty or whitespace-only ADMIN_SECRET", () => {
    // An unset Cloudflare secret can surface as "" — that must not shadow the
    // fallback and lock ops out of the routes they would use to fix it.
    expect(adminCredential({ ADMIN_SECRET: "   ", SYNC_SECRET_KEY: "signing" })).toEqual({
      secret: "signing",
      source: "sync-secret-key-fallback",
    })
  })

  it("returns null when neither secret is bound, so the route fails closed", () => {
    expect(adminCredential({})).toBeNull()
  })

  it("does not trim the SYNC_SECRET_KEY fallback", () => {
    // auth-worker builds its bearer from an untrimmed copy of the same value.
    // Trimming here and not there would 401 every call if the secret ever
    // carried stray whitespace — a regression the fallback exists to avoid.
    expect(adminCredential({ SYNC_SECRET_KEY: "signing " })?.secret).toBe("signing ")
  })
})

describe("handleAdminRequest auth", () => {
  it("accepts the dedicated secret", async () => {
    const res = await handleAdminRequest(
      del("Bearer dedicated"),
      envWith({ ADMIN_SECRET: "dedicated", SYNC_SECRET_KEY: "signing" }),
    )
    expect(res?.status).toBe(200)
  })

  it("rejects the signing key once ADMIN_SECRET is set", async () => {
    // This is the property that makes step 3 of the migration verifiable: with
    // the dedicated secret bound, the signing key is no longer an admin
    // credential even before the fallback branch is deleted.
    const res = await handleAdminRequest(
      del("Bearer signing"),
      envWith({ ADMIN_SECRET: "dedicated", SYNC_SECRET_KEY: "signing" }),
    )
    expect(res?.status).toBe(401)
  })

  it("still accepts the signing key when ADMIN_SECRET is unset", async () => {
    const res = await handleAdminRequest(
      del("Bearer signing"),
      envWith({ SYNC_SECRET_KEY: "signing" }),
    )
    expect(res?.status).toBe(200)
  })

  it("rejects a request with no Authorization header", async () => {
    const res = await handleAdminRequest(del(), envWith({ ADMIN_SECRET: "dedicated" }))
    expect(res?.status).toBe(401)
  })

  it("fails closed when no admin credential is configured at all", async () => {
    const res = await handleAdminRequest(del("Bearer anything"), envWith())
    expect(res?.status).toBe(401)
  })

  it("returns null for non-admin paths so the caller falls through", async () => {
    const res = await handleAdminRequest(
      new Request("https://sync.example/events"),
      envWith({ ADMIN_SECRET: "dedicated" }),
    )
    expect(res).toBeNull()
  })

  it("requires auth before revealing whether a route exists", async () => {
    // /admin/nope 404s without auth, but a real resource must 401 rather than
    // 405 — otherwise the method check becomes an unauthenticated probe.
    const res = await handleAdminRequest(
      new Request("https://sync.example/admin/files/p1/f1", { method: "PUT" }),
      envWith({ ADMIN_SECRET: "dedicated" }),
    )
    expect(res?.status).toBe(401)
  })
})
