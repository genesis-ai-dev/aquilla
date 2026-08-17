import { describe, expect, it } from "vitest"
import { adminBearerMatches, resolveAdminSecret } from "./admin-secret"

// OPS-13 follow-up. `resolveAdminSecret` trims BOTH candidates, so every sender
// of an admin bearer has to trim too or the two sides silently disagree. The
// one machine caller is auth-worker's R2 cleanup on file delete
// (auth-worker/src/routes/projects.ts), and it only console.warns on failure —
// so a normalisation mismatch does not surface as an error, it surfaces as
// deleted files quietly keeping their blobs in R2.
//
// The realistic trigger is mundane: `echo secret | wrangler secret put` stores
// a trailing newline where `printf %s secret |` does not.

describe("resolveAdminSecret", () => {
  it("prefers the dedicated secret over the signing key", () => {
    expect(resolveAdminSecret({ ADMIN_SECRET: "dedicated", SYNC_SECRET_KEY: "signing" })).toBe(
      "dedicated",
    )
  })

  it("falls back to the signing key only while ADMIN_SECRET is unset", () => {
    expect(resolveAdminSecret({ SYNC_SECRET_KEY: "signing" })).toBe("signing")
  })

  it("treats a whitespace-only ADMIN_SECRET as unset", () => {
    // A cleared Cloudflare secret can surface as "". It must not shadow the
    // fallback and lock ops out of the routes they would use to fix it.
    expect(resolveAdminSecret({ ADMIN_SECRET: "   ", SYNC_SECRET_KEY: "signing" })).toBe("signing")
  })

  it("fails closed when neither is configured", () => {
    expect(resolveAdminSecret({})).toBeNull()
  })

  it("trims both candidates, so senders must trim to match", () => {
    // This is the contract auth-worker depends on. If either side stops
    // trimming, the pair below stops agreeing.
    expect(resolveAdminSecret({ ADMIN_SECRET: " dedicated\n" })).toBe("dedicated")
    expect(resolveAdminSecret({ SYNC_SECRET_KEY: " signing\n" })).toBe("signing")
  })
})

describe("adminBearerMatches", () => {
  it("accepts the dedicated secret", () => {
    expect(adminBearerMatches("Bearer dedicated", { ADMIN_SECRET: "dedicated" })).toBe(true)
  })

  it("rejects the signing key once ADMIN_SECRET is set", () => {
    // The whole point of OPS-2: provisioning must NARROW what is accepted.
    expect(
      adminBearerMatches("Bearer signing", { ADMIN_SECRET: "dedicated", SYNC_SECRET_KEY: "signing" }),
    ).toBe(false)
  })

  it("rejects everything when no secret is configured", () => {
    expect(adminBearerMatches("Bearer anything", {})).toBe(false)
    expect(adminBearerMatches("", {})).toBe(false)
  })

  it("matches a bearer built from the same value the sender trimmed", () => {
    // Mirrors auth-worker: `c.env.ADMIN_SECRET?.trim() || c.env.SYNC_SECRET_KEY?.trim()`.
    // A secret stored with a trailing newline still authenticates, because both
    // ends normalise it identically.
    const env = { SYNC_SECRET_KEY: "signing\n" }
    const sent = env.SYNC_SECRET_KEY.trim()
    expect(adminBearerMatches(`Bearer ${sent}`, env)).toBe(true)
  })

  it("would reject an untrimmed sender — the regression this guards", () => {
    const env = { SYNC_SECRET_KEY: "signing\n" }
    expect(adminBearerMatches(`Bearer ${env.SYNC_SECRET_KEY}`, env)).toBe(false)
  })
})
