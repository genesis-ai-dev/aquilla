// OPSEC review 2026-11-16 (OPS-56 / OPS-57): the per-member lane/file scope
// write is an AUTHORIZATION write, and its PROJECT_LEAD floor was satisfied by
// platform-admin power alone on every project on the platform.
//
// `resolveProjectRole` contributes { source: "platform", level: 700 } for every
// platform operator and ROLE.PROJECT_LEAD is 500, so
// `callerRole.level < ROLE.PROJECT_LEAD` was false by definition for an
// un-elevated admin JWT.
//
// Why this route is more than "one more un-gated write":
//
//   1. One PUT replace-sets TWO tables: `project_member_scopes` and, through
//      `syncMemberLaneGrants`, `project_member_lane_roles` — the table the lane
//      read wall actually enforces (AQU-730 / AQU-1415).
//   2. A grant row is STANDING access that outlives the request. The wall reads
//      the member's own grants and has no actor to check, so an elevation check
//      at use time can never reach who wrote the row. Fifth instance of the
//      shape OPS-44 (PAT), OPS-49 (integration link), OPS-51 (source link) and
//      OPS-53 (termbase subscription) each named.
//   3. `planLaneGrants` reads an EMPTY scope set as "every lane", so the
//      cheapest request on the route — `{ scopes: [] }` — is the WIDENING one.
//
// And two guards downstream of the floor read the caller's LEVEL, so narrowing
// the role without threading it through them would have been cosmetic: the
// self-edit refusal (cleared by an admin's 700 as a "maintainer") and
// `mergeLanesALimitedCallerMayGrant`, whose `lanesHeldByCaller` returns "every
// lane" at MAINTAINER+ and so skipped "you can only grant lanes you hold".
//
// OPS-57 is pinned here too: `scopes` carried no cap and `value` no length
// bound, while the handler does one awaited INSERT per scope plus one per
// planned grant against the single-writer datastore.
//
// Base test allowlist is ADMIN_EMAILS=root@example.com (pg-test-env), so the
// seeded "root" user is the platform admin.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const ROOT_ID = 7

const ELEVATION_ERROR =
  "elevation required to manage a member's lane scopes with platform-admin access"

const sql = (query: string, ...binds: unknown[]) =>
  env.AQUILLA_PG.prepare(query)
    .bind(...binds)
    .run()

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"
  env.LANE_READ_WALL = "1"

  await seedUser(1, "tenant-owner")
  await seedUser(2, "tenant-lead")
  await seedUser(3, "tenant-contributor")
  await seedUser(4, "stranger")
  // Owns root's own org and created its project, so root's GENUINE standing
  // there is exactly the project_lead row below — not an org-owner 700, which
  // would legitimately carry every lane and make §4 untestable.
  await seedUser(5, "root-org-owner")
  await seedUser(ROOT_ID, "root")

  // Org 1 is the tenant root reaches ONLY through platform power.
  // Org 2 is root's own, where they hold a genuine grant — the control.
  await sql(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Tenant Org', 1), (2, 'Root Org', 5)",
  )
  await sql(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1), (2, 5, 700, 5), (2, ?, 400, 5)`,
    ROOT_ID,
  )
  await sql(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('ms', 'Tenant Scopes', 1, 1),
       ('root-ms', 'Root Scopes', 2, 5)`,
  )
  await sql(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
       ('ms', 2, 500, 1),
       ('ms', 3, 400, 1)`,
  )
  // root's GENUINE project_lead grant on their own org's project, plus a
  // member to scope there. Without the genuine grant the controls below could
  // not tell "narrowed correctly" from "locked the operator out of their own
  // work" — OPS-51's lesson.
  await sql(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
       ('root-ms', ?, 500, 5),
       ('root-ms', 3, 400, 5),
       ('root-ms', 5, 700, 5)`,
    ROOT_ID,
  )
  // French carries the legacy '' default tag, so the legacy-client pin below
  // exercises the value the OPS-57 cap deliberately still admits.
  await sql(
    `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position, archived_at) VALUES
       ('lane-fr', 'ms', 'target', 'French',  NULL, '',   1, NULL),
       ('lane-es', 'ms', 'target', 'Spanish', NULL, 'es', 2, NULL),
       ('lane-rt-a', 'root-ms', 'target', 'German', NULL, 'de', 1, NULL),
       ('lane-rt-b', 'root-ms', 'target', 'Polish', NULL, 'pl', 2, NULL)`,
  )
})

afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
  env.LANE_READ_WALL = undefined
})

const put = async (
  as: string,
  projectId: string,
  targetUserId: number,
  scopes: Array<{ kind: string; value: string }>,
) =>
  app.request(
    `/api/v2/projects/${projectId}/members/${targetUserId}/scopes`,
    { method: "PUT", headers: authHeader(await jwtFor(as)), body: JSON.stringify({ scopes }) },
    env,
  )

const elevate = async (username: string): Promise<string> => {
  const jwt = await jwtFor(username)
  const req = await app.request(
    "/api/v2/admin/elevation/request",
    { method: "POST", headers: authHeader(jwt) },
    env,
  )
  const { devCode } = (await req.json()) as { devCode?: string }
  const res = await app.request(
    "/api/v2/admin/elevation/verify",
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ code: devCode }) },
    env,
  )
  expect(res.status).toBe(200)
  return jwt
}

/** The grant rows the lane read wall actually enforces. */
const grantsFor = async (projectId: string, userId: number): Promise<string[]> => {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT lane FROM project_member_lane_roles WHERE project_id = ? AND user_id = ? ORDER BY lane",
  )
    .bind(projectId, userId)
    .all<{ lane: string }>()
  return (rows.results ?? []).map((r) => r.lane)
}

const scopeRowsFor = async (projectId: string, userId: number): Promise<string[]> => {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT kind, value FROM project_member_scopes WHERE project_id = ? AND user_id = ? ORDER BY kind, value",
  )
    .bind(projectId, userId)
    .all<{ kind: string; value: string }>()
  return (rows.results ?? []).map((r) => `${r.kind}:${r.value}`)
}

/** The tenant's own lead walls contributor 3 down to Spanish. */
const tenantScopesContributorToSpanish = async () => {
  const res = await put("tenant-lead", "ms", 3, [{ kind: "lane", value: "lane-es" }])
  expect(res.status).toBe(200)
  expect(await grantsFor("ms", 3)).toEqual(["lane-es"])
}

// ──────────────────────────────────────────────────────────────────────────
// 1. The widening direction — the cheapest request on the route
// ──────────────────────────────────────────────────────────────────────────

describe("PUT scopes — widening a walled member (OPS-56)", () => {
  it("refuses an un-elevated platform admin, and the member keeps only their one lane", async () => {
    await tenantScopesContributorToSpanish()

    const res = await put("root", "ms", 3, [])

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERROR })
    // The point of the finding: an empty replace-set is "every lane", so a
    // 200 here would have handed the walled contributor French as well.
    expect(await grantsFor("ms", 3)).toEqual(["lane-es"])
  })

  it("lets an ELEVATED platform admin through, and then it does widen", async () => {
    await tenantScopesContributorToSpanish()
    const jwt = await elevate("root")

    const res = await app.request(
      "/api/v2/projects/ms/members/3/scopes",
      { method: "PUT", headers: authHeader(jwt), body: JSON.stringify({ scopes: [] }) },
      env,
    )

    expect(res.status).toBe(200)
    expect(await grantsFor("ms", 3)).toEqual(["lane-es", "lane-fr"])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2. The narrowing direction — walling a member off their own work
// ──────────────────────────────────────────────────────────────────────────

describe("PUT scopes — narrowing a member (OPS-56)", () => {
  it("refuses an un-elevated platform admin, and the member's lanes do not move", async () => {
    await tenantScopesContributorToSpanish()

    const res = await put("root", "ms", 3, [{ kind: "lane", value: "lane-fr" }])

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERROR })
    expect(await grantsFor("ms", 3)).toEqual(["lane-es"])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3. The self-edit guard, which an admin's 700 cleared as a "maintainer"
// ──────────────────────────────────────────────────────────────────────────

describe("PUT scopes — an admin scoping THEMSELVES (OPS-56)", () => {
  it("refuses, and writes no scope row for them on a tenant project they do not belong to", async () => {
    const res = await put("root", "ms", ROOT_ID, [{ kind: "file", value: "f1" }])

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERROR })
    expect(await scopeRowsFor("ms", ROOT_ID)).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4. The lane-limited merge, which 700 skipped entirely. This is the proof
//    the narrowing is threaded through the guards rather than cosmetic.
// ──────────────────────────────────────────────────────────────────────────

describe("PUT scopes — a lane-limited operator on their OWN project (OPS-56)", () => {
  /**
   * root's genuine standing on root-ms is project_lead, limited to German —
   * and member 3 already holds German, so the lane-limited merge has an
   * existing set to reason about rather than the "already has every lane"
   * refusal an empty one produces.
   */
  const limitRootToGerman = async () => {
    const seeded = await put("root-org-owner", "root-ms", 3, [
      { kind: "lane", value: "lane-rt-a" },
    ])
    expect(seeded.status).toBe(200)
    await sql(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
       VALUES ('root-ms', ?, 'lane', 'lane-rt-a', ?, 0)`,
      ROOT_ID,
      String(ROOT_ID),
    )
  }

  it("may still grant a lane they hold — the operator is not locked out of their own work", async () => {
    await limitRootToGerman()

    const res = await put("root", "root-ms", 3, [{ kind: "lane", value: "lane-rt-a" }])

    expect(res.status).toBe(200)
    expect(await grantsFor("root-ms", 3)).toEqual(["lane-rt-a"])
  })

  it("may NOT grant a lane they do not hold, now that the merge reads their genuine level", async () => {
    await limitRootToGerman()

    const res = await put("root", "root-ms", 3, [{ kind: "lane", value: "lane-rt-b" }])

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: "you can only grant lanes you hold",
      lanes: ["lane-rt-b"],
    })
    // Unchanged: still only the German they were seeded with.
    expect(await grantsFor("root-ms", 3)).toEqual(["lane-rt-a"])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 5. Controls — the refusals and successes that must not move
// ──────────────────────────────────────────────────────────────────────────

describe("PUT scopes — controls", () => {
  it("the tenant's own project lead performs the write", async () => {
    const res = await put("tenant-lead", "ms", 3, [{ kind: "lane", value: "lane-es" }])
    expect(res.status).toBe(200)
  })

  it("a contributor gets the byte-identical pre-OPS-56 floor refusal", async () => {
    const res = await put("tenant-contributor", "ms", 2, [])
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "project_lead required to manage scopes" })
  })

  it("a non-member gets the byte-identical pre-OPS-56 no-access refusal", async () => {
    const res = await put("stranger", "ms", 3, [])
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "no access to project" })
  })

  it("the legacy '' default-lane value is still admitted (OPS-57 took no .min(1))", async () => {
    const res = await put("tenant-lead", "ms", 3, [{ kind: "lane", value: "" }])
    expect(res.status).toBe(200)
    expect(await grantsFor("ms", 3)).toEqual(["lane-fr"])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 6. The three READS stay open to an un-elevated admin (AQU-2003)
// ──────────────────────────────────────────────────────────────────────────

describe("the reads are deliberately not narrowed (AQU-2003)", () => {
  const get = async (as: string, path: string) =>
    app.request(path, { headers: authHeader(await jwtFor(as)) }, env)

  it("a member's scopes stay readable", async () => {
    const res = await get("root", "/api/v2/projects/ms/members/3/scopes")
    expect(res.status).toBe(200)
  })

  it("lane staffing stays readable", async () => {
    const res = await get("root", "/api/v2/projects/ms/lane-staffing")
    expect(res.status).toBe(200)
  })

  it("a member's lane assignments stay readable", async () => {
    const res = await get("root", "/api/v2/projects/ms/members/3/lane-assignments?lane=lane-es")
    expect(res.status).toBe(200)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 7. OPS-57 — the caps
// ──────────────────────────────────────────────────────────────────────────

describe("the scopes payload is capped (OPS-57)", () => {
  const fileScopes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ kind: "file", value: `f${i}` }))

  it("refuses more than 500 scopes before the handler runs", async () => {
    const res = await put("tenant-lead", "ms", 3, fileScopes(501))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid scopes payload" })
    expect(await scopeRowsFor("ms", 3)).toEqual([])
  })

  it("refuses a scope value longer than 256 characters", async () => {
    const res = await put("tenant-lead", "ms", 3, [{ kind: "file", value: "x".repeat(257) }])
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid scopes payload" })
    expect(await scopeRowsFor("ms", 3)).toEqual([])
  })

  it("still admits a 500-scope save and a 256-character value", async () => {
    const res = await put("tenant-lead", "ms", 3, [
      ...fileScopes(499),
      { kind: "file", value: "y".repeat(256) },
    ])
    expect(res.status).toBe(200)
    expect((await scopeRowsFor("ms", 3)).length).toBe(500)
  })
})
