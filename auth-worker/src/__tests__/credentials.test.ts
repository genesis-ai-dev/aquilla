import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { validateApiCredential } from "../../../db/shared/api-credentials"
import { CREDENTIAL_MINT_MAX_PER_USER } from "../utils/rate-limit"

type CreateResponse = {
  token: string
  credential: {
    id: string
    name: string
    mode: "ask" | "act"
    orgId: string | null
    projectId: string | null
    tokenPrefix: string
    createdAt: string
    expiresAt: string | null
    lastUsedAt: string | null
    revokedAt: string | null
  }
}

async function seedProject(id: string, createdBy: number, orgId: number | null = null): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, ?, ?)",
  )
    .bind(id, `Project ${id}`, orgId, createdBy)
    .run()
}

async function grantProjectRole(projectId: string, userId: number, level: number, grantedBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, level, grantedBy)
    .run()
}

async function mint(
  username: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    "/api/v2/credentials",
    { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) },
    env,
  )
}

describe("POST /api/v2/credentials + validateApiCredential", () => {
  it("mints an unscoped ask credential and validates it back (roundtrip)", async () => {
    await seedUser(1, "alice")
    const res = await mint("alice", { name: "my token", mode: "ask" })
    expect(res.status).toBe(201)
    const body = (await res.json()) as CreateResponse
    expect(body.token.startsWith("aqk_")).toBe(true)
    expect(body.credential.tokenPrefix).toBe(body.token.slice(0, 12))
    expect(body.credential.mode).toBe("ask")

    const ctx = await validateApiCredential(env.AQUILLA_PG, body.token)
    expect(ctx).not.toBeNull()
    expect(ctx).toMatchObject({
      credentialId: body.credential.id,
      userId: "1",
      username: "alice",
      mode: "ask",
      orgId: null,
      projectId: null,
    })
  })

  it("returns null for an unknown / malformed token", async () => {
    expect(await validateApiCredential(env.AQUILLA_PG, "not-a-token")).toBeNull()
    expect(await validateApiCredential(env.AQUILLA_PG, "aqk_deadbeef")).toBeNull()
    expect(await validateApiCredential(env.AQUILLA_PG, "")).toBeNull()
  })

  it("throttles invalid-credential attempts per source IP, without punishing other IPs or opted-out callers", async () => {
    await seedUser(1, "alice")
    const body = (await (await mint("alice", { name: "t", mode: "ask" })).json()) as CreateResponse

    const attackerIp = "203.0.113.7"
    // Exhaust the per-IP invalid-attempt budget with garbage tokens.
    for (let i = 0; i < 30; i++) {
      expect(await validateApiCredential(env.AQUILLA_PG, "aqk_" + "0".repeat(40), attackerIp)).toBeNull()
    }
    // The budget is now spent — even a genuinely valid token from that IP is
    // rejected without a DB lookup, since the whole point is to stop the flood
    // regardless of whether any individual guess would have succeeded.
    expect(await validateApiCredential(env.AQUILLA_PG, body.token, attackerIp)).toBeNull()

    // A different source IP was never recorded against and isn't throttled.
    expect(await validateApiCredential(env.AQUILLA_PG, body.token, "198.51.100.9")).not.toBeNull()

    // Callers that don't pass an IP (e.g. legacy call sites) skip throttling
    // entirely rather than sharing one global bucket.
    expect(await validateApiCredential(env.AQUILLA_PG, body.token)).not.toBeNull()
  })

  it("never throttles repeated attempts with the correct token", async () => {
    await seedUser(1, "alice")
    const body = (await (await mint("alice", { name: "t", mode: "ask" })).json()) as CreateResponse
    const ip = "203.0.113.8"
    for (let i = 0; i < 40; i++) {
      expect(await validateApiCredential(env.AQUILLA_PG, body.token, ip)).not.toBeNull()
    }
  })

  it("rejects an expired credential", async () => {
    await seedUser(1, "alice")
    const body = (await (await mint("alice", { name: "t", mode: "ask" })).json()) as CreateResponse
    // Backdate expiry to the past.
    await env.AQUILLA_PG.prepare(
      "UPDATE api_credentials SET expires_at = now() - interval '1 hour' WHERE id = ?",
    )
      .bind(body.credential.id)
      .run()
    expect(await validateApiCredential(env.AQUILLA_PG, body.token)).toBeNull()
  })

  it("rejects a revoked credential (and revoke is idempotent)", async () => {
    await seedUser(1, "alice")
    const body = (await (await mint("alice", { name: "t", mode: "ask" })).json()) as CreateResponse

    const del1 = await app.request(
      `/api/v2/credentials/${body.credential.id}`,
      { method: "DELETE", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(del1.status).toBe(200)
    expect(await validateApiCredential(env.AQUILLA_PG, body.token)).toBeNull()

    // Repeat revoke — still 200, revoked_at unchanged.
    const before = await env.AQUILLA_PG.prepare(
      "SELECT revoked_at FROM api_credentials WHERE id = ?",
    ).bind(body.credential.id).first<{ revoked_at: string }>()
    const del2 = await app.request(
      `/api/v2/credentials/${body.credential.id}`,
      { method: "DELETE", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(del2.status).toBe(200)
    const after = await env.AQUILLA_PG.prepare(
      "SELECT revoked_at FROM api_credentials WHERE id = ?",
    ).bind(body.credential.id).first<{ revoked_at: string }>()
    expect(String(after?.revoked_at)).toBe(String(before?.revoked_at))
  })

  it("lets a maintainer mint an act credential scoped to their project", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "owner")
    await seedProject("proj-1", 2)
    await grantProjectRole("proj-1", 1, 600, 2) // MAINTAINER
    const res = await mint("alice", { name: "act token", mode: "act", projectId: "proj-1" })
    expect(res.status).toBe(201)
    const body = (await res.json()) as CreateResponse
    expect(body.credential.mode).toBe("act")
    expect(body.credential.projectId).toBe("proj-1")

    const ctx = await validateApiCredential(env.AQUILLA_PG, body.token)
    expect(ctx?.mode).toBe("act")
    expect(ctx?.projectId).toBe("proj-1")
  })

  it("lets a contributor mint an ask credential but not an act one", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "owner")
    await seedProject("proj-1", 2)
    await grantProjectRole("proj-1", 1, 400, 2) // CONTRIBUTOR

    const ask = await mint("alice", { name: "ask", mode: "ask", projectId: "proj-1" })
    expect(ask.status).toBe(201)

    const act = await mint("alice", { name: "act", mode: "act", projectId: "proj-1" })
    expect(act.status).toBe(403)
    expect(((await act.json()) as { error: string }).error).toBe("scope_denied")
  })

  it("forbids scoping a credential to a project the caller is not a member of", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "owner")
    await seedProject("proj-1", 2) // alice has no membership
    const res = await mint("alice", { name: "t", mode: "ask", projectId: "proj-1" })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe("scope_denied")
  })

  it("requires a scope for act-mode credentials", async () => {
    await seedUser(1, "alice")
    const res = await mint("alice", { name: "t", mode: "act" })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe("scope_denied")
  })

  // [Pen test] API security & data exposure (2026-08-13): guards the
  // credential_mint throttle in utils/rate-limit.ts.
  it("throttles a caller minting more than the per-user limit", async () => {
    await seedUser(1, "alice")
    for (let i = 0; i < CREDENTIAL_MINT_MAX_PER_USER; i++) {
      const res = await mint("alice", { name: `t${i}`, mode: "ask" })
      expect(res.status).toBe(201)
    }
    const throttled = await mint("alice", { name: "one-too-many", mode: "ask" })
    expect(throttled.status).toBe(429)
    expect(((await throttled.json()) as { error: string }).error).toBe("rate_limited")
  })

  it("does not let one user's minting throttle a different user", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    for (let i = 0; i < CREDENTIAL_MINT_MAX_PER_USER; i++) {
      expect((await mint("alice", { name: `t${i}`, mode: "ask" })).status).toBe(201)
    }
    expect((await mint("alice", { name: "throttled", mode: "ask" })).status).toBe(429)
    expect((await mint("bob", { name: "still-fine", mode: "ask" })).status).toBe(201)
  })
})

describe("GET /api/v2/credentials", () => {
  it("lists the caller's credentials and never exposes hashes", async () => {
    await seedUser(1, "alice")
    await mint("alice", { name: "one", mode: "ask" })
    await mint("alice", { name: "two", mode: "ask" })

    const res = await app.request(
      "/api/v2/credentials",
      { headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { credentials: Record<string, unknown>[] }
    expect(body.credentials).toHaveLength(2)
    for (const cred of body.credentials) {
      expect(cred).not.toHaveProperty("token_hash")
      expect(cred).not.toHaveProperty("tokenHash")
      expect(cred).toHaveProperty("tokenPrefix")
    }
  })

  it("does not list another user's credentials", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await mint("alice", { name: "alice-token", mode: "ask" })

    const res = await app.request(
      "/api/v2/credentials",
      { headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { credentials: unknown[] }
    expect(body.credentials).toHaveLength(0)
  })
})

describe("DELETE /api/v2/credentials/:id", () => {
  it("404s a non-owner's revoke attempt the same as an unknown id (no existence oracle)", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    const body = (await (await mint("alice", { name: "t", mode: "ask" })).json()) as CreateResponse

    const forbidden = await app.request(
      `/api/v2/credentials/${body.credential.id}`,
      { method: "DELETE", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    // [Pen test] Auth & session mgmt (2026-08-24): must be indistinguishable
    // from the "no such id" case below, or the status code itself leaks
    // whether a given credential id exists.
    expect(forbidden.status).toBe(404)
    // Still valid — not revoked by the failed attempt.
    expect(await validateApiCredential(env.AQUILLA_PG, body.token)).not.toBeNull()

    const missing = await app.request(
      `/api/v2/credentials/${crypto.randomUUID()}`,
      { method: "DELETE", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(missing.status).toBe(404)
  })

  // AQU-1180 — the `pii` flag decides whether an agent token can see the names
  // of everyone who has edited the project. That is a decision about other
  // people's safety, so it is off by default and an owner's call to turn on.
  describe("pii flag (AQU-1180)", () => {
    it("defaults to off when the field is omitted", async () => {
      await seedUser(1, "alice")
      const body = (await (await mint("alice", { name: "t", mode: "ask" })).json()) as CreateResponse
      const ctx = await validateApiCredential(env.AQUILLA_PG, body.token)
      expect(ctx?.pii).toBe(false)
    })

    it("lets an owner mint a pii credential scoped to their project", async () => {
      await seedUser(1, "alice")
      await seedProject("proj-1", 1)
      await grantProjectRole("proj-1", 1, 700, 1) // OWNER
      const res = await mint("alice", {
        name: "pii token",
        mode: "ask",
        projectId: "proj-1",
        pii: true,
      })
      expect(res.status).toBe(201)
      const body = (await res.json()) as CreateResponse
      const ctx = await validateApiCredential(env.AQUILLA_PG, body.token)
      expect(ctx?.pii).toBe(true)
    })

    it("denies a non-owner (maintainer) minting pii: on", async () => {
      await seedUser(1, "alice")
      await seedUser(2, "owner")
      await seedProject("proj-1", 2)
      await grantProjectRole("proj-1", 1, 600, 2) // MAINTAINER — write access, not ownership
      const res = await mint("alice", {
        name: "pii token",
        mode: "ask",
        projectId: "proj-1",
        pii: true,
      })
      expect(res.status).toBe(403)
      expect((await res.json()) as { error: string }).toMatchObject({ error: "permission_denied" })
    })

    it("denies pii: on for an unscoped credential — there is no owner to decide", async () => {
      await seedUser(1, "alice")
      const res = await mint("alice", { name: "pii token", mode: "ask", pii: true })
      expect(res.status).toBe(403)
      expect((await res.json()) as { error: string }).toMatchObject({ error: "permission_denied" })
    })

    it("a maintainer can still mint a normal (scrubbed) credential", async () => {
      await seedUser(1, "alice")
      await seedUser(2, "owner")
      await seedProject("proj-1", 2)
      await grantProjectRole("proj-1", 1, 600, 2)
      const res = await mint("alice", { name: "t", mode: "act", projectId: "proj-1", pii: false })
      expect(res.status).toBe(201)
      const body = (await res.json()) as CreateResponse
      expect((await validateApiCredential(env.AQUILLA_PG, body.token))?.pii).toBe(false)
    })
  })
})
