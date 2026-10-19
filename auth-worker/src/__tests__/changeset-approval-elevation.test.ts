// OPSEC review 2026-10-19 (OPS-47): the human approval gate in front of agent
// writes is authority-based, and platform-admin authority satisfied it with no
// step-up elevation — on every tenant's project.
//
// `resolveProjectRole` contributes { source: "platform", level: 700 } for every
// platform admin on every project, and 700 is ROLE.OWNER — the highest floor
// any plan can carry, including UNREADABLE_PLAN_FLOOR. So an un-elevated admin
// cleared every floor on the approve / reject / assign writes.
//
// AQU-2003 (2026-10-16) decided the un-elevated platform posture is READ-ONLY:
// a platform-only caller gets a Viewer sync token and the sync-worker refuses
// `src: "platform"` below Contributor. Approval escapes that decision entirely,
// because the write that follows is made by the AGENT's credential, not by any
// platform-sourced token — so none of the sync-worker's platform rules see it.
//
// The read (GET /:id/approval) is deliberately left open, matching AQU-2003.
//
// Base test allowlist is ADMIN_EMAILS=root@example.com (pg-test-env), so the
// seeded "root" user is the platform admin. Org 1 is a tenant root does not
// belong to; org 2 is one where root is a genuine Maintainer.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const ROOT_ID = 7
const DIGEST = "sha256:deadbeef"

const sql = (query: string, ...binds: unknown[]) =>
  env.AQUILLA_PG.prepare(query)
    .bind(...binds)
    .run()

/** A one-cell translation plan: floor CONTRIBUTOR (400). */
const SET_TRANSLATION_PLAN = [
  { kind: "SetTranslation", fileId: "file-1", cellId: "c-a", value: "New draft" },
]

async function seedCredential(userId: number): Promise<string> {
  const id = crypto.randomUUID()
  await sql(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode)
     VALUES (?, ?, 'test-cred', 'aqk_test', ?, 'ask')`,
    id,
    String(userId),
    `hash-${id}`,
  )
  return id
}

async function seedChangeset(
  id: string,
  projectId: string,
  credentialId: string,
  commands: unknown[] = SET_TRANSLATION_PLAN,
): Promise<void> {
  await sql(
    `INSERT INTO changesets
        (id, project_id, created_by_user_id, credential_id, autonomy_mode, status,
         commands, preconditions, summary, digest, expires_at)
     VALUES (?, ?, '1', ?, 'ask', 'staged', ?::jsonb, '[]'::jsonb, ?::jsonb, ?, ?)`,
    id,
    projectId,
    credentialId,
    JSON.stringify(commands),
    JSON.stringify({ translationsAdded: 1, translationsModified: 0, warnings: [] }),
    DIGEST,
    new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  )
}

let credential: string

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"
  await seedUser(1, "owner")
  await seedUser(2, "alice")
  await seedUser(ROOT_ID, "root")

  await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'PartnerOrg', 1)")
  await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'RootOrg', 1)")
  for (const [org, user, role] of [
    [1, 1, 700],
    [1, 2, 400],
    [2, 1, 700],
    [2, ROOT_ID, 600],
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
  // alice is a real Contributor on it. Her org role (400) is NOT an access path
  // on its own — AQU-435 makes only Maintainer+ one — so the grant is direct.
  await sql(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-t', 2, 400, 1)",
  )
  // proj-r: root holds a genuine org Maintainer (600) grant here.
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-r', 'RootOwn', 2, 1)")

  credential = await seedCredential(1)
  await seedChangeset("cs-tenant", "proj-t", credential)
  await seedChangeset("cs-root", "proj-r", credential)
})

afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
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

const confirmations = async (changesetId: string): Promise<number> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT COUNT(*)::int AS n FROM changeset_confirmations WHERE changeset_id = ?",
  )
    .bind(changesetId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const statusOf = async (changesetId: string): Promise<string | null> => {
  const row = await env.AQUILLA_PG.prepare("SELECT status FROM changesets WHERE id = ?")
    .bind(changesetId)
    .first<{ status: string }>()
  return row?.status ?? null
}

describe("OPS-47: platform-admin approval needs elevation", () => {
  it("un-elevated admin cannot approve another tenant's changeset, and mints nothing", async () => {
    const res = await call("root", "POST", "/api/v2/changesets/cs-tenant/approve", {
      digest: DIGEST,
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("permission_denied")
    expect(body.error.message).toContain("elevation required")
    expect(await confirmations("cs-tenant")).toBe(0)
  })

  it("un-elevated admin cannot reject another tenant's changeset", async () => {
    const res = await call("root", "POST", "/api/v2/changesets/cs-tenant/reject")
    expect(res.status).toBe(403)
    expect(await statusOf("cs-tenant")).toBe("staged")
  })

  it("un-elevated admin cannot assign another tenant's changeset", async () => {
    const res = await call("root", "POST", "/api/v2/changesets/cs-tenant/assign", { userId: "2" })
    expect(res.status).toBe(403)
  })

  it("elevation restores the admin path", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call(
      "root",
      "POST",
      "/api/v2/changesets/cs-tenant/approve",
      { digest: DIGEST },
      jwt,
    )
    expect(res.status).toBe(200)
    expect(await confirmations("cs-tenant")).toBe(1)
  })

  it("an operator's GENUINE grant is untouched: no elevation needed on their own org's project", async () => {
    const res = await call("root", "POST", "/api/v2/changesets/cs-root/approve", { digest: DIGEST })
    expect(res.status).toBe(200)
    expect(await confirmations("cs-root")).toBe(1)
  })

  it("an ordinary member who holds the floor is unaffected", async () => {
    const res = await call("alice", "POST", "/api/v2/changesets/cs-tenant/approve", {
      digest: DIGEST,
    })
    expect(res.status).toBe(200)
  })

  it("the unreadable-plan floor (OWNER) is not satisfiable by un-elevated admin power", async () => {
    // A corrupt plan deliberately fails closed to owner-only. Platform power is
    // exactly 700, so it cleared even this before the fix.
    await seedChangeset("cs-corrupt", "proj-t", credential, [{ kind: "NotACommand" }])
    const res = await call("root", "POST", "/api/v2/changesets/cs-corrupt/approve", {
      digest: DIGEST,
    })
    expect(res.status).toBe(403)
    expect(await confirmations("cs-corrupt")).toBe(0)
  })

  it("the approval READ stays open to a platform admin (AQU-2003 read-only posture)", async () => {
    const res = await call("root", "GET", "/api/v2/changesets/cs-tenant/approval")
    expect(res.status).toBe(200)
  })
})
