// OPS-2 (docs/OPSEC-REVIEW-2026-08-13.md): the admin and migration routes
// accept a dedicated ADMIN_SECRET so operators stop handling the token-signing
// key, while SYNC_SECRET_KEY keeps working for the service-to-service callers.
//
// The properties that matter, and why each has a test:
//   - provisioning ADMIN_SECRET cannot lock out an existing caller;
//   - the new secret actually works before anything else is migrated;
//   - an unbound admin surface fails closed rather than open;
//   - a route that carries the fallback is verifiably still gated.

import { describe, it, expect } from "vitest"
import { hasAdminSecretConfigured, isAuthorizedAdminBearer } from "../lib/admin-auth"
import { handleAdminRequest } from "../admin"

const ADMIN = "admin-secret-value"
const SIGNING = "sync-signing-key"

describe("isAuthorizedAdminBearer", () => {
  it("accepts the dedicated admin secret", () => {
    expect(isAuthorizedAdminBearer(`Bearer ${ADMIN}`, { ADMIN_SECRET: ADMIN })).toBe(true)
  })

  it("still accepts the signing key so provisioning ADMIN_SECRET locks nobody out", () => {
    const env = { ADMIN_SECRET: ADMIN, SYNC_SECRET_KEY: SIGNING }
    expect(isAuthorizedAdminBearer(`Bearer ${SIGNING}`, env)).toBe(true)
    expect(isAuthorizedAdminBearer(`Bearer ${ADMIN}`, env)).toBe(true)
  })

  it("works before ADMIN_SECRET exists (the pre-provisioning state)", () => {
    expect(isAuthorizedAdminBearer(`Bearer ${SIGNING}`, { SYNC_SECRET_KEY: SIGNING })).toBe(true)
  })

  it("rejects a wrong secret, a bare token, and an empty header", () => {
    const env = { ADMIN_SECRET: ADMIN, SYNC_SECRET_KEY: SIGNING }
    expect(isAuthorizedAdminBearer("Bearer nope", env)).toBe(false)
    expect(isAuthorizedAdminBearer(ADMIN, env)).toBe(false)
    expect(isAuthorizedAdminBearer("", env)).toBe(false)
  })

  it("rejects everything when no secret is bound — an unconfigured admin surface fails closed", () => {
    expect(isAuthorizedAdminBearer("Bearer anything", {})).toBe(false)
    expect(isAuthorizedAdminBearer("Bearer ", {})).toBe(false)
    expect(hasAdminSecretConfigured({})).toBe(false)
    expect(hasAdminSecretConfigured({ ADMIN_SECRET: ADMIN })).toBe(true)
    expect(hasAdminSecretConfigured({ SYNC_SECRET_KEY: SIGNING })).toBe(true)
  })
})

describe("admin route wiring", () => {
  const snapshots = {
    list: async () => ({ objects: [], truncated: false }),
    delete: async () => undefined,
  } as unknown as R2Bucket

  function req(secret: string | null) {
    return new Request("https://worker/admin/files/p1/f1", {
      method: "DELETE",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    })
  }

  it("authorizes with ADMIN_SECRET", async () => {
    const res = await handleAdminRequest(req(ADMIN), {
      SNAPSHOTS: snapshots,
      ADMIN_SECRET: ADMIN,
      SYNC_SECRET_KEY: SIGNING,
    })
    expect(res?.status).toBe(200)
  })

  it("authorizes with SYNC_SECRET_KEY — auth-worker calls this route with it", async () => {
    const res = await handleAdminRequest(req(SIGNING), {
      SNAPSHOTS: snapshots,
      ADMIN_SECRET: ADMIN,
      SYNC_SECRET_KEY: SIGNING,
    })
    expect(res?.status).toBe(200)
  })

  it("401s an unknown bearer and a missing header", async () => {
    const env = { SNAPSHOTS: snapshots, ADMIN_SECRET: ADMIN, SYNC_SECRET_KEY: SIGNING }
    expect((await handleAdminRequest(req("wrong"), env))?.status).toBe(401)
    expect((await handleAdminRequest(req(null), env))?.status).toBe(401)
  })

  it("401s when neither secret is bound", async () => {
    const res = await handleAdminRequest(req(ADMIN), { SNAPSHOTS: snapshots })
    expect(res?.status).toBe(401)
  })
})
