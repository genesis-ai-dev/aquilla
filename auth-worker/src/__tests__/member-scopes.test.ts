// AQU-553 (Slice 5): per-member lane/file scopes CRUD + token plumbing.
//
// Pins:
//   * GET floors — a member reads their OWN scopes at viewer (100+); reading
//     someone else's needs project_lead (500+).
//   * PUT floors — replace-set requires project_lead (500+).
//   * Replace-set semantics — PUT overwrites, empty clears.
//   * The 500+-unscopable rule — scoping a lead/maintainer/owner is a 400.
//   * The sync-token `scopes` claim — included when the user has scope rows,
//     OMITTED entirely when they don't.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import { verify } from "hono/jwt"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const SYNC_SECRET = "sync-secret"

interface TokenClaims {
  userId: number
  scopes?: Array<{ kind: "lane" | "file"; value: string }>
}

// user 1 = owner (700), user 2 = contributor (400), user 3 = lead (500),
// user 4 = reviewer (300).
async function seedProject(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "carol") // contributor
  await seedUser(3, "lead")
  await seedUser(4, "rev") // reviewer
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-s', 'Scopes', NULL, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-s', 2, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-s', 3, 500, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-s', 4, 300, 1)",
  ).run()
}

async function putScopes(
  jwt: string,
  targetUserId: number,
  scopes: Array<{ kind: string; value: string }>,
): Promise<Response> {
  return app.request(
    `/api/v2/projects/proj-s/members/${targetUserId}/scopes`,
    {
      method: "PUT",
      headers: authHeader(jwt),
      body: JSON.stringify({ scopes }),
    },
    env,
  )
}

beforeEach(async () => {
  await seedProject()
})

describe("AQU-553 member-scopes — GET floors", () => {
  it("lets a member read their OWN scopes (viewer 100+)", async () => {
    const jwt = await jwtFor("carol")
    const res = await app.request(
      "/api/v2/projects/proj-s/members/2/scopes",
      { method: "GET", headers: authHeader(jwt) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scopes: [] })
  })

  it("403s a contributor reading ANOTHER member's scopes", async () => {
    const jwt = await jwtFor("carol") // contributor 400
    const res = await app.request(
      "/api/v2/projects/proj-s/members/4/scopes",
      { method: "GET", headers: authHeader(jwt) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("lets a lead (500+) read another member's scopes", async () => {
    const owner = await jwtFor("owner")
    await putScopes(owner, 2, [{ kind: "lane", value: "es" }])
    const jwt = await jwtFor("lead")
    const res = await app.request(
      "/api/v2/projects/proj-s/members/2/scopes",
      { method: "GET", headers: authHeader(jwt) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scopes: [{ kind: "lane", value: "es" }] })
  })
})

describe("AQU-553 member-scopes — PUT floors + replace-set", () => {
  it("403s a contributor trying to set scopes", async () => {
    const jwt = await jwtFor("carol") // 400
    const res = await putScopes(jwt, 4, [{ kind: "lane", value: "es" }])
    expect(res.status).toBe(403)
  })

  it("lets a lead set scopes and replaces the whole set", async () => {
    const jwt = await jwtFor("owner")
    let res = await putScopes(jwt, 2, [
      { kind: "lane", value: "" },
      { kind: "lane", value: "es" },
      { kind: "file", value: "file-a" },
    ])
    expect(res.status).toBe(200)
    let body = (await res.json()) as { scopes: Array<{ kind: string; value: string }> }
    expect(body.scopes).toEqual([
      { kind: "file", value: "file-a" },
      { kind: "lane", value: "" },
      { kind: "lane", value: "es" },
    ])

    // Replace-set: a second PUT overwrites entirely.
    res = await putScopes(jwt, 2, [{ kind: "lane", value: "fr" }])
    expect(res.status).toBe(200)
    body = (await res.json()) as { scopes: Array<{ kind: string; value: string }> }
    expect(body.scopes).toEqual([{ kind: "lane", value: "fr" }])
  })

  it("clears all scopes on an empty replace-set", async () => {
    const jwt = await jwtFor("owner")
    await putScopes(jwt, 2, [{ kind: "lane", value: "es" }])
    const res = await putScopes(jwt, 2, [])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ scopes: [] })
  })

  it("rejects an invalid kind", async () => {
    const jwt = await jwtFor("owner")
    const res = await putScopes(jwt, 2, [{ kind: "chapter", value: "x" }])
    expect(res.status).toBe(400)
  })
})

describe("AQU-553 member-scopes — leads must stay unscoped", () => {
  it("400s scoping a member whose role is >= 500", async () => {
    const jwt = await jwtFor("owner")
    const res = await putScopes(jwt, 3, [{ kind: "lane", value: "es" }]) // user 3 = lead 500
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: "scopes are for contributor/reviewer roles",
    })
  })

  it("still allows CLEARING a lead's scopes (empty set)", async () => {
    const jwt = await jwtFor("owner")
    const res = await putScopes(jwt, 3, [])
    expect(res.status).toBe(200)
  })
})

describe("AQU-553 sync-token — scopes claim included/omitted", () => {
  it("OMITS the scopes claim when the user is unscoped", async () => {
    const jwt = await jwtFor("carol")
    const res = await app.request(
      "/api/v2/sync-token",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId: "proj-s", fileId: "f1" }) },
      env,
    )
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const claims = (await verify(token, SYNC_SECRET, "HS256")) as unknown as TokenClaims
    expect(claims.scopes).toBeUndefined()
  })

  it("INCLUDES the scopes claim once the user has scope rows", async () => {
    const owner = await jwtFor("owner")
    await putScopes(owner, 2, [
      { kind: "lane", value: "es" },
      { kind: "file", value: "file-a" },
    ])
    const jwt = await jwtFor("carol")
    const res = await app.request(
      "/api/v2/sync-token",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId: "proj-s", fileId: "f1" }) },
      env,
    )
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const claims = (await verify(token, SYNC_SECRET, "HS256")) as unknown as TokenClaims
    expect(claims.scopes).toEqual([
      { kind: "file", value: "file-a" },
      { kind: "lane", value: "es" },
    ])
  })
})
