// AQU-626: per-user deep link + PIN (fresh-browser / diode-zone flow).
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// Decode a JWT payload without verifying (env uses HS256 / frontier-test-secret).
function jwtSub(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
  return payload.sub as string
}

async function seedProjectWithCreator(projectId: string, creatorId: number, creator: string) {
  await seedUser(creatorId, creator)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(projectId, "Test", creatorId)
    .run()
}

async function mintLink(
  projectId: string,
  creator: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    "/api/v2/access-links",
    { method: "POST", headers: authHeader(await jwtFor(creator)), body: JSON.stringify(body) },
    env,
  )
}

async function redeem(token: string, pin: string): Promise<Response> {
  return app.request(
    `/api/v2/access-links/${token}/redeem`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) },
    env,
  )
}

describe("POST /api/v2/access-links (mint)", () => {
  it("mints a per-user link, caps role at contributor, and ensures membership", async () => {
    await seedProjectWithCreator("proj-1", 1, "alice")
    await seedUser(2, "translator")

    const res = await mintLink("proj-1", "alice", {
      projectId: "proj-1",
      userId: 2,
      pin: "4821",
      roleLevel: 700, // request owner; must be capped to contributor
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; projectId: string; userId: number; role: number }
    expect(body.projectId).toBe("proj-1")
    expect(body.userId).toBe(2)
    expect(body.role).toBe(400)
    expect(body.token.length).toBeGreaterThan(16)

    // PIN is stored hashed (scrypt), never in plaintext.
    const row = await env.AQUILLA_PG.prepare(
      "SELECT pin_hash FROM project_access_links WHERE token = ?",
    )
      .bind(body.token)
      .first<{ pin_hash: string }>()
    expect(row?.pin_hash.startsWith("scrypt:")).toBe(true)
    expect(row?.pin_hash).not.toContain("4821")

    // Membership was ensured for the bound account so it can read on arrival.
    const member = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'proj-1' AND user_id = 2",
    ).first<{ role_level: number }>()
    expect(member?.role_level).toBe(400)
  })

  it("rejects a caller without project_lead+ with 403", async () => {
    await seedProjectWithCreator("proj-1", 99, "creator")
    await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-1', 2, 400, 99)",
    ).run()
    await seedUser(3, "translator")

    const res = await mintLink("proj-1", "bob", { projectId: "proj-1", userId: 3, pin: "1234" })
    expect(res.status).toBe(403)
  })

  it("404s when the target user does not exist", async () => {
    await seedProjectWithCreator("proj-1", 1, "alice")
    const res = await mintLink("proj-1", "alice", { projectId: "proj-1", userId: 4242, pin: "1234" })
    expect(res.status).toBe(404)
  })

  it("404s when the project does not exist", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "translator")
    const res = await mintLink("nope", "alice", { projectId: "nope", userId: 2, pin: "1234" })
    expect(res.status).toBe(404)
  })

  it("rejects a non-numeric or too-short PIN with 400", async () => {
    await seedProjectWithCreator("proj-1", 1, "alice")
    await seedUser(2, "translator")
    const bad = await mintLink("proj-1", "alice", { projectId: "proj-1", userId: 2, pin: "abc" })
    expect(bad.status).toBe(400)
    const short = await mintLink("proj-1", "alice", { projectId: "proj-1", userId: 2, pin: "12" })
    expect(short.status).toBe(400)
  })
})

describe("POST /api/v2/access-links/:token/redeem", () => {
  async function setup(pin = "4821"): Promise<string> {
    await seedProjectWithCreator("proj-1", 1, "alice")
    await seedUser(2, "translator")
    const res = await mintLink("proj-1", "alice", { projectId: "proj-1", userId: 2, pin })
    const body = (await res.json()) as { token: string }
    return body.token
  }

  it("mints a session for the bound account on the correct PIN", async () => {
    const token = await setup("4821")
    const res = await redeem(token, "4821")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      access_token: string
      token_type: string
      username: string
      project_id: string
    }
    expect(body.token_type).toBe("bearer")
    expect(body.username).toBe("translator")
    expect(body.project_id).toBe("proj-1")
    // The minted JWT authenticates the BOUND account, not the minter.
    expect(jwtSub(body.access_token)).toBe("translator")
  })

  it("treats a wrong PIN as a dead link and increments the attempt counter", async () => {
    const token = await setup("4821")
    const res = await redeem(token, "0000")
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("This link is invalid or has expired.")

    const row = await env.AQUILLA_PG.prepare(
      "SELECT failed_attempts FROM project_access_links WHERE token = ?",
    )
      .bind(token)
      .first<{ failed_attempts: number }>()
    expect(row?.failed_attempts).toBe(1)
  })

  it("returns the SAME dead-link response for an unknown token (no oracle)", async () => {
    const res = await redeem("deadbeefdeadbeefdeadbeefdeadbeef", "4821")
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("This link is invalid or has expired.")
  })

  it("locks the link after repeated wrong PINs — even the correct PIN then fails", async () => {
    const token = await setup("4821")
    for (let i = 0; i < 5; i++) {
      const r = await redeem(token, "0000")
      expect(r.status).toBe(401)
    }
    // Now locked: the correct PIN is rejected while the lockout window is open.
    const locked = await redeem(token, "4821")
    expect(locked.status).toBe(401)
    const row = await env.AQUILLA_PG.prepare(
      "SELECT locked_until FROM project_access_links WHERE token = ?",
    )
      .bind(token)
      .first<{ locked_until: string | null }>()
    expect(row?.locked_until).not.toBeNull()
  })

  it("resets the attempt counter on a successful redemption", async () => {
    const token = await setup("4821")
    await redeem(token, "0000") // one failure
    await redeem(token, "4821") // success resets
    const row = await env.AQUILLA_PG.prepare(
      "SELECT failed_attempts, locked_until, last_used_at FROM project_access_links WHERE token = ?",
    )
      .bind(token)
      .first<{ failed_attempts: number; locked_until: string | null; last_used_at: string | null }>()
    expect(row?.failed_attempts).toBe(0)
    expect(row?.locked_until).toBeNull()
    expect(row?.last_used_at).not.toBeNull()
  })

  it("is reusable — re-opening the link after a browser wipe works identically", async () => {
    const token = await setup("4821")
    const first = await redeem(token, "4821")
    expect(first.status).toBe(200)
    const second = await redeem(token, "4821")
    expect(second.status).toBe(200)
    const b = (await second.json()) as { username: string }
    expect(b.username).toBe("translator")
  })

  it("treats an expired link as dead", async () => {
    const token = await setup("4821")
    await env.AQUILLA_PG.prepare(
      "UPDATE project_access_links SET expires_at = '2000-01-01T00:00:00Z' WHERE token = ?",
    )
      .bind(token)
      .run()
    const res = await redeem(token, "4821")
    expect(res.status).toBe(401)
  })

  it("treats a revoked link as dead", async () => {
    const token = await setup("4821")
    const revoke = await app.request(
      `/api/v2/access-links/${token}/revoke`,
      { method: "POST", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(revoke.status).toBe(200)
    const res = await redeem(token, "4821")
    expect(res.status).toBe(401)
  })
})

describe("POST /api/v2/access-links/:token/revoke", () => {
  it("requires project_lead+ on the link's project", async () => {
    await seedProjectWithCreator("proj-1", 1, "alice")
    await seedUser(2, "translator")
    const mint = await mintLink("proj-1", "alice", { projectId: "proj-1", userId: 2, pin: "4821" })
    const { token } = (await mint.json()) as { token: string }

    // A contributor (below project_lead) cannot revoke.
    await seedUser(3, "mallory")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-1', 3, 400, 1)",
    ).run()
    const res = await app.request(
      `/api/v2/access-links/${token}/revoke`,
      { method: "POST", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})
