// OPSEC review 2026-10-26 (OPS-49): the progress-sync integration routers
// (Monday AQU-804, Airtable AQU-804, LangQuest AQU-2105) make exactly one
// authorization decision each — orgGuard / projectGuard in
// routes/_integration-helpers.ts — and both resolvers behind them hand a
// platform admin the top of the ladder on every tenant. So an un-elevated
// admin JWT cleared every MANAGE_MIN_ROLE floor in all three routers.
//
// What those floors protect is not another un-gated write: they decide WHERE a
// project's progress leaves Aquilla and ON WHOSE credential. The push carries
// project and file names, each language, completion figures, the last-activity
// date and `translators` — the usernames of every member at CONTRIBUTOR+ — and
// the link it writes outlives the session, with the five-minute cron pushing
// on. AQU-2003 priced un-elevated platform access as READ-ONLY on our own
// content; a standing egress channel into a third party is not that.
//
// The rule under test: an asserted role floor is not satisfied by platform
// power unless the session is elevated. A guard called with minRole == null —
// the status read the SPA makes on every project open — is deliberately NOT
// narrowed, which is AQU-2003 applied here rather than a new judgment.
//
// Base test allowlist is ADMIN_EMAILS=root@example.com (pg-test-env), so the
// seeded "root" user is the platform admin. Org 1 is a tenant root does not
// belong to; org 2 is one where root is a genuine Maintainer.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const ROOT_ID = 7

const sql = (query: string, ...binds: unknown[]) =>
  env.AQUILLA_PG.prepare(query)
    .bind(...binds)
    .run()

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"
  // Nothing on a denied path may reach a vendor. Any fetch is a test failure.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`unexpected fetch in test: ${new Request(input).url}`)
    }),
  )

  await seedUser(1, "owner")
  await seedUser(2, "anna")
  await seedUser(ROOT_ID, "root")

  await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Tenant', 1)")
  await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'RootOrg', 1)")
  for (const [org, user, role] of [
    [1, 1, 700],
    [1, 2, 600], // anna: an ordinary org Maintainer, the control that must not regress
    [2, 1, 700],
    [2, ROOT_ID, 600], // root's GENUINE grant, on its own org
  ]) {
    await sql(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
      org,
      user,
      role,
    )
  }

  // proj-t: a tenant project root reaches ONLY through platform power.
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-t', 'Tenant', 1, 1)")
  // proj-r: root holds a genuine org Maintainer (600) grant here.
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-r', 'RootOwn', 2, 1)")

  // The tenant's live Airtable connection and the link it drives.
  await sql(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by, environment)
     VALUES ('conn-at', '1', 'airtable', '{"email":"anna@tenant.example"}', 'enc', 'anna', 'test')`,
  )
  // anna also holds a DIRECT project grant, so the control below can drop her
  // org role without losing the access path AQU-435 withholds from org 400.
  await sql(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-t', 2, 400, 1)",
  )
  await sql(
    `INSERT INTO integration_links
        (id, project_id, provider, connection_id, external_id, external_name, config, created_by)
     VALUES ('link-at', 'proj-t', 'airtable', 'conn-at', 'appTENANT00000001', 'Tracker', '{}', 'anna')`,
  )
})

afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
  vi.unstubAllGlobals()
})

const call = async (as: string, method: string, path: string, body?: unknown, jwt?: string) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(jwt ?? (await jwtFor(as))),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

const elevate = async (jwt: string) => {
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
}

const connectionCount = async (orgId: number): Promise<number> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT COUNT(*)::int AS n FROM integration_connections WHERE org_id = ?",
  )
    .bind(String(orgId))
    .first<{ n: number }>()
  return row?.n ?? 0
}

const linkTarget = async (): Promise<string | null> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT external_id FROM integration_links WHERE id = 'link-at'",
  ).first<{ external_id: string }>()
  return row?.external_id ?? null
}

describe("OPS-49: an integration role floor needs elevation to be met with admin power", () => {
  it("un-elevated admin cannot plant a credential in another tenant's org, and writes nothing", async () => {
    const res = await call("root", "PUT", "/api/v2/airtable/orgs/1/connection", {
      token: "patATTACKERTOKEN0000",
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain("elevation required")
    // The tenant's own connection is untouched — no second row, no replacement.
    expect(await connectionCount(1)).toBe(1)
  })

  it("un-elevated admin cannot repoint another tenant's project at a base of their choosing", async () => {
    const res = await call("root", "PUT", "/api/v2/airtable/projects/proj-t/link", {
      baseId: "appATTACKER000001",
      tableId: "tblATTACKER00001",
      config: {},
    })
    expect(res.status).toBe(403)
    expect(await linkTarget()).toBe("appTENANT00000001")
  })

  it("un-elevated admin cannot disconnect another tenant's integration", async () => {
    const res = await call("root", "DELETE", "/api/v2/airtable/orgs/1/connection")
    expect(res.status).toBe(403)
    expect(await connectionCount(1)).toBe(1)
  })

  it("un-elevated admin cannot push another tenant's project data out", async () => {
    // 403 at the guard, NOT the 404 a caller past it gets for an unlinked project.
    for (const path of [
      "/api/v2/monday/projects/proj-t/sync",
      "/api/v2/airtable/projects/proj-t/sync",
    ]) {
      expect((await call("root", "POST", path)).status).toBe(403)
    }
  })

  it("the same floor holds in the LangQuest router, which shares the guard", async () => {
    const res = await call("root", "PUT", "/api/v2/langquest/projects/proj-t/link", {
      token: "lqp_abcdefghijklmnopqrst",
      languageId: "eng",
    })
    expect(res.status).toBe(403)
  })

  it("elevation restores the admin path", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", "DELETE", "/api/v2/airtable/projects/proj-t/link", undefined, jwt)
    expect(res.status).toBe(200)
    expect(await linkTarget()).toBeNull()
  })

  it("an operator's GENUINE grant is untouched: no elevation needed on their own org's project", async () => {
    // proj-r has no link, so a guard that passed answers 200 { deleted: false }.
    const res = await call("root", "DELETE", "/api/v2/airtable/projects/proj-r/link")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: false })
  })

  it("an ordinary org Maintainer is unaffected, and still sees the old 403 wording", async () => {
    expect((await call("anna", "DELETE", "/api/v2/airtable/projects/proj-t/link")).status).toBe(200)
    // A member BELOW the floor gets the pre-OPS-49 message, not an elevation
    // hint: her direct project grant (400) is the access path that remains.
    await sql("UPDATE org_members SET role_level = 400 WHERE org_id = 1 AND user_id = 2")
    const res = await call("anna", "POST", "/api/v2/airtable/projects/proj-t/sync")
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe(
      "project role >= maintainer (600) required",
    )
  })

  it("AQU-2003 is preserved: the member-level status reads stay open un-elevated", async () => {
    const conn = await call("root", "GET", "/api/v2/airtable/orgs/1/connection")
    expect(conn.status).toBe(200)
    const link = await call("root", "GET", "/api/v2/airtable/projects/proj-t/link")
    expect(link.status).toBe(200)
    const lq = await call("root", "GET", "/api/v2/langquest/projects/proj-t/link")
    expect(lq.status).toBe(200)
  })
})
