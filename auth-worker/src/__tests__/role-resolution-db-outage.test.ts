// AQU-996: a transient DB failure during role resolution must NOT read as
// "no access". During the 2026-08-25 blip, `safeFirst` swallowed the failing
// membership queries to null, so a real contributor resolved to no role, the
// sync-token mint answered 403 "No access to project", and the SPA outbox —
// which treats a mint 403 as permanently forbidden — quarantined her comment
// with a bogus permission error. These pin the fix: lookup failure with no
// grant found → RoleLookupError → mint reason "role_lookup_failed" → 503,
// while a genuine non-member still gets 403, and paths that don't need the
// failed queries (creator) still resolve.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { jwtFor, authHeader, seedUser } from "./helpers/db"
import { resolveProjectRole, RoleLookupError } from "../services/project-permissions"
import type { AuthUser, Env } from "../types"

/** Wrap the real DB so only the membership-path queries fail — the shape of a
 *  partial outage (and of the full blip once middleware hydration succeeds). */
function membershipOutageDb(): typeof env.AQUILLA_PG {
  const real = env.AQUILLA_PG
  const fail = async (): Promise<never> => {
    throw new Error("simulated membership query failure")
  }
  const failingStmt = { bind: () => failingStmt, first: fail, run: fail, all: fail, raw: fail }
  return {
    prepare(sql: string) {
      if (/\b(project_members|group_project_grants|org_members)\b/.test(sql)) {
        return failingStmt
      }
      return real.prepare(sql)
    },
  } as unknown as typeof env.AQUILLA_PG
}

function authUser(id: number, username: string): AuthUser {
  return {
    id,
    username,
    email: `${username}@example.com`,
    password_hash: "x",
    preferences: {},
    created_at: "",
    updated_at: "",
    password_changed_at: null,
  }
}

async function seedProject(id: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(id, `Project ${id}`, createdBy)
    .run()
}

describe("role resolution under DB outage (AQU-996)", () => {
  it("sync-token mint answers 503 (not 403) when membership queries fail for a real contributor", async () => {
    await seedUser(9001, "outage-contrib")
    await seedUser(9002, "outage-owner")
    await seedProject("p-outage", 9002)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p-outage', 9001, 400)",
    ).run()

    const token = await jwtFor("outage-contrib")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ projectId: "p-outage", fileId: "__project__" }),
      },
      { ...env, AQUILLA_PG: membershipOutageDb() },
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    // Must not be the permission wording the outbox quarantines on.
    expect(body.error).not.toContain("No access")
    expect(body.error).toContain("retry")
  })

  it("still answers 403 No access for a genuine non-member on a healthy DB", async () => {
    await seedUser(9003, "outage-nonmember")
    await seedUser(9005, "outage-other-owner")
    await seedProject("p-noaccess", 9005)

    const token = await jwtFor("outage-nonmember")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ projectId: "p-noaccess", fileId: "__project__" }),
      },
      env,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: "No access to project" })
  })

  it("a path that needs no membership query (creator) still resolves during the outage", async () => {
    await seedUser(9004, "outage-creator")
    await seedProject("p-creator", 9004)

    const token = await jwtFor("outage-creator")
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ projectId: "p-creator", fileId: "__project__" }),
      },
      { ...env, AQUILLA_PG: membershipOutageDb() },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 700, source: "creator" })
  })

  it("resolveProjectRole throws RoleLookupError (never null) when denial would rest on failed queries", async () => {
    await seedUser(9006, "outage-direct")
    await seedUser(9007, "outage-direct-owner")
    await seedProject("p-direct", 9007)

    const outageEnv = { ...env, AQUILLA_PG: membershipOutageDb() } as unknown as Env
    await expect(
      resolveProjectRole(outageEnv, authUser(9006, "outage-direct"), "p-direct"),
    ).rejects.toBeInstanceOf(RoleLookupError)
  })
})
