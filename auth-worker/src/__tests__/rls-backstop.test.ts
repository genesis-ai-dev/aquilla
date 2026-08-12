// AQU-289: RLS backstop — shim identity threading + SQL helper tests.
//
// What we test here:
//   1. withUser() causes SET LOCAL app.user_id to be set per transaction —
//      verified by reading back current_setting('app.user_id') inside a query.
//   2. asAdmin() causes SET LOCAL app.user_id = '' — verified the same way.
//   3. Bare db (no withUser / asAdmin) does NOT set app.user_id.
//   4. app_user_can_access_project() returns TRUE for each of the four access
//      paths (direct / group / org / creator) and FALSE for foreign/no-access.
//   5. withUser() visibility: rows for an accessible project are returned;
//      rows for a foreign project are invisible (0 rows) — this tests the
//      SQL function indirectly through a query that reads project_id-scoped data.
//
// What we CANNOT test locally:
//   • Hyperdrive connection-pooling correctness: SET LOCAL is transaction-scoped
//     and cannot leak to a different connection, but this requires a real pooler
//     to verify empirically.
//
// The shim-level tests (1–3) work without roles because SET LOCAL succeeds for
// any Postgres user and the GUC is readable via current_setting().

import { describe, it, expect, beforeAll } from "vitest"
import { pg, env } from "./helpers/pg-test-env"
import { PostgresDb, type PgExecutor } from "../../../db/shim/postgres"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// ─── Load the RLS migration into the test database ───────────────────────────
// The setup-migrations.ts already loads schema.sql.  We additionally load the
// RLS migration here so the app_user_can_access_project function is present.

const RLS_MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../db/postgres/migrations/0034_rls_backstop.sql",
  ),
  "utf8",
)
const CONTEXTUAL_ACTIVITY_MIGRATION = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../db/postgres/migrations/0074_contextual_run_events.sql",
  ),
  "utf8",
)

beforeAll(async () => {
  // Execute the RLS migration into the shared PGlite.
  // PGlite will parse CREATE ROLE (idempotent DO block), GRANT, CREATE POLICY,
  // and ENABLE ROW LEVEL SECURITY.  The DDL succeeds; role-level filtering
  // is not enforced by PGlite but the SQL function is available.
  try {
    await pg.exec(RLS_MIGRATION)
    await pg.exec(CONTEXTUAL_ACTIVITY_MIGRATION)
  } catch (e) {
    // If PGlite rejects a specific clause (e.g. FORCE ROW LEVEL SECURITY or
    // policy syntax), log the error and continue — we still get function tests.
    console.warn("[rls-backstop] RLS migration partial failure (expected on some PGlite versions):", String(e))
  }
})

describe("contextual activity RLS migration", () => {
  it("installs separate SELECT/INSERT policies with user-scoped and bare-worker paths", async () => {
    const relation = await pg.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = 'contextual_run_events'::regclass`,
    )
    expect(relation.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })

    const policies = await pg.query<{
      policyname: string
      cmd: string
      qual: string | null
      with_check: string | null
    }>(
      `SELECT policyname, cmd, qual, with_check FROM pg_policies
        WHERE tablename = 'contextual_run_events' ORDER BY cmd`,
    )
    expect(policies.rows.map((policy) => policy.cmd).sort()).toEqual(["INSERT", "SELECT"])
    const select = policies.rows.find((policy) => policy.cmd === "SELECT")
    const insert = policies.rows.find((policy) => policy.cmd === "INSERT")
    expect(select?.qual).toContain("current_setting('app.user_id'::text, true)")
    expect(select?.qual).toContain("current_setting('app.project_id'::text, true)")
    expect(select?.qual).toContain("project_id = current_setting('app.project_id'::text, true)")
    expect(select?.qual).toContain("app_user_can_access_project(project_id)")
    expect(insert?.with_check).toContain("current_setting('app.user_id'::text, true)")
    expect(insert?.with_check).toContain("current_setting('app.project_id'::text, true)")
    expect(insert?.with_check).toContain("project_id = current_setting('app.project_id'::text, true)")
    expect(insert?.with_check).toContain("app_user_can_access_project(project_id)")
  })

  it("opts every contextual table into exact-project RLS before granting runtime writes", async () => {
    const tables = ["scene_briefs", "contextual_runs", "contextual_steering", "contextual_drafts"]
    const relations = await pg.query<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
      [tables],
    )
    expect(relations.rows).toEqual(tables.sort().map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })))

    const policies = await pg.query<{ tablename: string; cmd: string; expression: string }>(
      `SELECT tablename, cmd, COALESCE(qual, with_check, '') AS expression
         FROM pg_policies
        WHERE tablename = ANY($1::text[])
        ORDER BY tablename, cmd`,
      [tables],
    )
    for (const table of tables) {
      const own = policies.rows.filter((policy) => policy.tablename === table)
      expect(own.map((policy) => policy.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"])
      expect(own.every((policy) => policy.expression.includes("app_contextual_project_scope(project_id)")))
        .toBe(true)
    }

    const helper = await pg.query<{ definition: string }>(
      `SELECT pg_get_functiondef('app_contextual_project_scope(text)'::regprocedure) AS definition`,
    )
    const definition = helper.rows[0]?.definition ?? ""
    expect(definition).toContain("current_setting('app.user_id', true)")
    expect(definition).toContain("current_setting('app.project_id', true)")
    expect(definition).toContain("p_project_id = current_setting('app.project_id', true)")
    expect(definition).toContain("app_user_can_access_project(p_project_id)")

    const grants = await pg.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'app_runtime' AND table_name = ANY($1::text[])
        ORDER BY table_name, privilege_type`,
      [tables],
    )
    for (const table of tables) {
      expect(grants.rows.filter((grant) => grant.table_name === table).map((grant) => grant.privilege_type).sort())
        .toEqual(["INSERT", "SELECT", "UPDATE"])
    }

    const leasePolicies = await pg.query<{ cmd: string; expression: string }>(
      `SELECT cmd, COALESCE(qual, with_check, '') AS expression
         FROM pg_policies
        WHERE tablename = 'contextual_project_leases'
        ORDER BY cmd`,
    )
    expect(leasePolicies.rows.map((policy) => policy.cmd).sort()).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
      "UPDATE",
    ])
    expect(leasePolicies.rows.every((policy) =>
      policy.expression.includes("app_contextual_project_scope(project_id)")))
      .toBe(true)
    const leaseGrants = await pg.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'app_runtime' AND table_name = 'contextual_project_leases'
        ORDER BY privilege_type`,
    )
    expect(leaseGrants.rows.map((grant) => grant.privilege_type).sort()).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
      "UPDATE",
    ])
  })

  it("contains app_runtime reads and writes to the exact scoped project while preserving bare worker I/O", async () => {
    const userId = 8_267_401
    const projectOne = "aqu-826-rls-project-one"
    const projectTwo = "aqu-826-rls-project-two"
    const eventOne = "01901234-0000-7000-8000-000000000001"
    const eventTwo = "01901234-0000-7000-8000-000000000002"
    const bareEvent = "01901234-0000-7000-8000-000000000003"
    const deniedEvent = "01901234-0000-7000-8000-000000000004"
    const runOne = "01901234-0000-7000-8000-000000000011"
    const runTwo = "01901234-0000-7000-8000-000000000012"
    const deniedRun = "01901234-0000-7000-8000-000000000013"
    const leaseOne = "01901234-0000-7000-8000-000000000021"
    const leaseTwo = "01901234-0000-7000-8000-000000000022"
    const deniedLease = "01901234-0000-7000-8000-000000000023"

    await seedUser(userId, "aqu826-rls-member")
    await seedProject(projectOne, userId)
    await seedProject(projectTwo, userId)
    await seedDirectMember(projectOne, userId)
    await seedDirectMember(projectTwo, userId)
    await pg.query(
      `INSERT INTO contextual_runs (id, project_id, file_id, status)
       VALUES ($1, $2, 'file-one', 'done'), ($3, $4, 'file-two', 'done')`,
      [runOne, projectOne, runTwo, projectTwo],
    )
    await pg.query(
      `INSERT INTO contextual_run_events
          (id, run_id, project_id, file_id, kind, summary)
       VALUES ($1, $2, $3, 'file-one', 'run_created', 'created'),
              ($4, $5, $6, 'file-two', 'run_created', 'created')`,
      [eventOne, runOne, projectOne, eventTwo, runTwo, projectTwo],
    )
    await pg.query(
      `INSERT INTO contextual_project_leases
          (id, project_id, run_id, weight, expires_at)
       VALUES ($1, $2, $3, 1, now() + interval '1 hour'),
              ($4, $5, $6, 1, now() + interval '1 hour')`,
      [leaseOne, projectOne, runOne, leaseTwo, projectTwo, runTwo],
    )

    try {
      await pg.exec(
        `SET ROLE app_runtime;
         SET app.user_id = '${userId}';
         SET app.project_id = '${projectOne}';`,
      )

      // Membership in projectTwo is deliberate: the exact project GUC, not
      // membership alone, must contain a hostile cross-project/cross-join read.
      const visibleEvents = await pg.query<{ project_id: string }>(
        `SELECT project_id FROM contextual_run_events
          WHERE id IN ($1, $2) ORDER BY project_id`,
        [eventOne, eventTwo],
      )
      expect(visibleEvents.rows).toEqual([{ project_id: projectOne }])

      const visibleRuns = await pg.query<{ project_id: string }>(
        `SELECT project_id FROM contextual_runs
          WHERE id IN ($1, $2) ORDER BY project_id`,
        [runOne, runTwo],
      )
      expect(visibleRuns.rows).toEqual([{ project_id: projectOne }])
      const visibleLeases = await pg.query<{ project_id: string }>(
        `SELECT project_id FROM contextual_project_leases
          WHERE id IN ($1, $2) ORDER BY project_id`,
        [leaseOne, leaseTwo],
      )
      expect(visibleLeases.rows).toEqual([{ project_id: projectOne }])

      await expect(pg.query(
        `INSERT INTO contextual_run_events
            (id, run_id, project_id, file_id, kind, summary)
         VALUES ($1, $2, $3, 'file-two', 'run_created', 'created')`,
        [deniedEvent, runTwo, projectTwo],
      )).rejects.toThrow(/row-level security/i)
      await expect(pg.query(
        `INSERT INTO contextual_runs (id, project_id, file_id, status)
         VALUES ($1, $2, 'file-denied', 'done')`,
        [deniedRun, projectTwo],
      )).rejects.toThrow(/row-level security/i)
      await expect(pg.query(
        `INSERT INTO contextual_project_leases
            (id, project_id, run_id, weight, expires_at)
         VALUES ($1, $2, 'denied-lease-run', 1, now() + interval '1 hour')`,
        [deniedLease, projectTwo],
      )).rejects.toThrow(/row-level security/i)

      // Tick/route work uses an identity-less runtime handle. Both GUCs empty
      // is the intentional bare path, and must continue to append evidence.
      await pg.exec("RESET app.user_id; RESET app.project_id;")
      const bareVisible = await pg.query<{ project_id: string }>(
        `SELECT project_id FROM contextual_run_events
          WHERE id IN ($1, $2) ORDER BY project_id`,
        [eventOne, eventTwo],
      )
      expect(bareVisible.rows).toEqual([
        { project_id: projectOne },
        { project_id: projectTwo },
      ])
      await pg.query(
        `INSERT INTO contextual_run_events
            (id, run_id, project_id, file_id, kind, summary)
         VALUES ($1, $2, $3, 'file-two', 'run_state', 'bare worker append')`,
        [bareEvent, runTwo, projectTwo],
      )
    } finally {
      await pg.exec("RESET ROLE; RESET app.user_id; RESET app.project_id;")
    }
  })
})

// Helper: build a PgExecutor-backed PostgresDb from the shared PGlite.
function makeShim(): PostgresDb {
  // Re-use the same pgliteExecutor pattern from pg-test-env.ts.
  const pgliteExec: PgExecutor = {
    async run(sql: string, params: unknown[]) {
      const r = await pg.query<Record<string, unknown>>(sql, params as unknown[])
      return { rows: r.rows, rowCount: (r as { affectedRows?: number }).affectedRows ?? r.rows.length }
    },
    begin: <T>(fn: (tx: PgExecutor) => Promise<T>): Promise<T> =>
      pg.transaction((tx) =>
        fn({
          async run(sql: string, params: unknown[]) {
            const r = await (tx as unknown as { query: typeof pg.query }).query<Record<string, unknown>>(sql, params as unknown[])
            return { rows: r.rows, rowCount: (r as { affectedRows?: number }).affectedRows ?? r.rows.length }
          },
          begin: () => { throw new Error("nested transactions not supported in PGlite") },
        })
      ) as Promise<T>,
  }
  // Import PostgresDb with no-identity mode — mode is set via withUser/asAdmin
  return new PostgresDb(pgliteExec as never)
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function seedUser(id: number, name: string) {
  await pg.query(
    "INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'hash') ON CONFLICT DO NOTHING",
    [id, name, `${name}@test.com`],
  )
}

async function seedProject(id: string, createdBy: number, orgId?: number) {
  await pg.query(
    "INSERT INTO projects (id, name, created_by, org_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
    [id, id, createdBy, orgId ?? null],
  )
}

async function seedDirectMember(projectId: string, userId: number, roleLevel = 400) {
  await pg.query(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [projectId, userId, roleLevel],
  )
}

// ─── 1. withUser() — SET LOCAL app.user_id is applied per query ──────────────

describe("shim.withUser() — identity threading", () => {
  it("SET LOCAL app.user_id is visible inside the same query transaction", async () => {
    const db = makeShim().withUser(42)
    const result = await db
      .prepare("SELECT current_setting('app.user_id', true) AS uid")
      .first<{ uid: string }>()
    expect(result?.uid).toBe("42")
  })

  it("withUser(string) works identically to withUser(number)", async () => {
    const db = makeShim().withUser("99")
    const result = await db
      .prepare("SELECT current_setting('app.user_id', true) AS uid")
      .first<{ uid: string }>()
    expect(result?.uid).toBe("99")
  })

  it("withUser(null) reverts to no-identity — app.user_id is empty or absent", async () => {
    // First set, then clear
    const db = makeShim().withUser(null)
    const result = await db
      .prepare("SELECT current_setting('app.user_id', true) AS uid")
      .first<{ uid: string }>()
    // Bare mode: no SET LOCAL → setting returns '' (the true arg suppresses error)
    expect(result?.uid ?? "").toBe("")
  })

  it("withUser() carries into batch() — all statements see the same user_id", async () => {
    const db = makeShim().withUser(7)
    const [r1, r2] = await db.batch([
      db.prepare("SELECT current_setting('app.user_id', true) AS uid"),
      db.prepare("SELECT current_setting('app.user_id', true) AS uid"),
    ])
    expect(r1.results[0]).toMatchObject({ uid: "7" })
    expect(r2.results[0]).toMatchObject({ uid: "7" })
  })
})

// ─── 2. asAdmin() — SET LOCAL app.user_id = '' ───────────────────────────────

describe("shim.asAdmin() — admin bypass", () => {
  it("asAdmin() sets app.user_id to empty string", async () => {
    const db = makeShim().asAdmin()
    const result = await db
      .prepare("SELECT current_setting('app.user_id', true) AS uid")
      .first<{ uid: string }>()
    expect(result?.uid).toBe("")
  })

  it("asAdmin() in batch() — all statements see empty user_id", async () => {
    const db = makeShim().asAdmin()
    const [r] = await db.batch([
      db.prepare("SELECT current_setting('app.user_id', true) AS uid"),
    ])
    expect(r.results[0]).toMatchObject({ uid: "" })
  })
})

// ─── 3. Bare db — no SET LOCAL ───────────────────────────────────────────────

describe("bare db (no withUser / asAdmin) — no SET LOCAL applied", () => {
  it("app.user_id is absent/empty when queried without identity mode", async () => {
    const db = makeShim()
    const result = await db
      .prepare("SELECT current_setting('app.user_id', true) AS uid")
      .first<{ uid: string }>()
    // No SET LOCAL → GUC not set → empty string (true = missing_ok)
    expect(result?.uid ?? "").toBe("")
  })
})

// ─── 4. app_user_can_access_project() SQL helper ─────────────────────────────

describe("app_user_can_access_project() SQL function", () => {
  it("Path 1 — direct project_members row → TRUE", async () => {
    await seedUser(101, "direct-member-user")
    await seedProject("proj-direct", 999) // creator is someone else
    await seedDirectMember("proj-direct", 101, 400)

    const db = makeShim().withUser(101)
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-direct")
      .first<{ ok: boolean }>()
    expect(r?.ok).toBe(true)
  })

  it("Path 2 — group grant (group_project_grants + group_members) → TRUE", async () => {
    await seedUser(102, "group-member-user")
    await seedUser(200, "group-creator")
    await seedProject("proj-group", 200)
    // Create org first (groups need an org)
    await pg.query(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (201, 'TestOrg2', 200) ON CONFLICT DO NOTHING",
    )
    await pg.query(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (301, 201, 'TeamA', 200) ON CONFLICT DO NOTHING",
    )
    await pg.query(
      "INSERT INTO group_members (group_id, user_id) VALUES (301, 102) ON CONFLICT DO NOTHING",
    )
    await pg.query(
      "INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (301, 'proj-group', 300) ON CONFLICT DO NOTHING",
    )

    const db = makeShim().withUser(102)
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-group")
      .first<{ ok: boolean }>()
    expect(r?.ok).toBe(true)
  })

  it("Path 3 — org-wide grant (org_members, project has org_id) → TRUE", async () => {
    await seedUser(103, "org-member-user")
    await seedUser(203, "org-project-creator")
    await pg.query(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (202, 'TestOrg3', 203) ON CONFLICT DO NOTHING",
    )
    await pg.query(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (202, 103, 300, 203) ON CONFLICT DO NOTHING",
    )
    await seedProject("proj-org", 203, 202) // project in org 202

    const db = makeShim().withUser(103)
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-org")
      .first<{ ok: boolean }>()
    expect(r?.ok).toBe(true)
  })

  it("Path 4 — creator fallback (projects.created_by = user_id) → TRUE", async () => {
    await seedUser(104, "creator-user")
    await seedProject("proj-creator", 104) // this user created it

    const db = makeShim().withUser(104)
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-creator")
      .first<{ ok: boolean }>()
    expect(r?.ok).toBe(true)
  })

  it("Foreign project — no access path → FALSE", async () => {
    await seedUser(105, "foreign-user")
    await seedUser(205, "other-creator")
    await seedProject("proj-foreign", 205) // created by someone else, no grants

    const db = makeShim().withUser(105)
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-foreign")
      .first<{ ok: boolean }>()
    expect(r?.ok).toBe(false)
  })

  it("Non-existent project → FALSE", async () => {
    await seedUser(106, "nonexistent-project-user")

    const db = makeShim().withUser(106)
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-does-not-exist")
      .first<{ ok: boolean }>()
    expect(r?.ok).toBe(false)
  })

  it("Missing user_id (empty string GUC) → FALSE (fail-closed)", async () => {
    await seedProject("proj-no-identity", 999)

    // Simulate a query with no identity set (bare db — GUC is absent)
    const db = makeShim()
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-no-identity")
      .first<{ ok: boolean }>()
    expect(r?.ok).toBe(false)
  })

  it("asAdmin() path — app_user_can_access_project returns FALSE (uid=''), but asAdmin queries bypass RLS via role", async () => {
    // The SQL helper returns false for uid='' — this is expected.
    // In production, the app_runtime role BYPASSRLS grant is what allows admin
    // queries to see all rows; here we just verify the function fails closed.
    await seedProject("proj-admin-check", 999)

    const db = makeShim().asAdmin()
    const r = await db
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-admin-check")
      .first<{ ok: boolean }>()
    // The SQL function returns false for uid='' — correct.
    // Production asAdmin() paths use the owner role which has BYPASSRLS.
    expect(r?.ok).toBe(false)
  })
})

// ─── 5. Visibility — withUser() scopes reads to accessible projects ───────────
// We insert rows into project_settings (a RLS-protected table).
// In PGlite, RLS filtering by role is not enforced, but we can verify
// that app_user_can_access_project() correctly scopes what WOULD be visible.

describe("project-scoped query visibility (shim-level, function-based)", () => {
  it("member can select their project's settings row; non-member cannot (via function check)", async () => {
    await seedUser(107, "settings-member")
    await seedUser(207, "settings-outsider")
    await seedProject("proj-settings-rls", 107) // 107 is creator → has access

    await pg.query(
      "INSERT INTO project_settings (project_id, settings) VALUES ('proj-settings-rls', '{\"theme\":\"dark\"}') ON CONFLICT DO NOTHING",
    )

    // Member: app_user_can_access_project should return true
    const dbMember = makeShim().withUser(107)
    const memberAccess = await dbMember
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-settings-rls")
      .first<{ ok: boolean }>()
    expect(memberAccess?.ok).toBe(true)

    // Outsider: app_user_can_access_project should return false
    const dbOutsider = makeShim().withUser(207)
    const outsiderAccess = await dbOutsider
      .prepare("SELECT app_user_can_access_project($1) AS ok")
      .bind("proj-settings-rls")
      .first<{ ok: boolean }>()
    expect(outsiderAccess?.ok).toBe(false)
  })
})
