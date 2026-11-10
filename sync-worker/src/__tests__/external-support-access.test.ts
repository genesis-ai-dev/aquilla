// AQU-2504 — connector SUPPORT ACCESS on the external read tier.
//
// The connector used to be strictly member-scoped: orgs-list.ts, projects-list.ts
// and read-auth.ts all resolved membership and nothing else, so a support
// engineer could not look at the project a customer was messaging them about.
// A platform admin may now opt into a time-boxed, read-only, cross-tenant grant
// at connector consent (auth-worker/src/routes/mcp-oauth.ts, covered by its own
// suite). This suite covers what that grant does once the token exists.
//
// The load-bearing assertions are the three the ticket names:
//
//   1. with the grant live, the connector lists and reads orgs and projects the
//      admin is not a member of, through BOTH adapters (REST and MCP);
//   2. without it — window closed, or not on the platform-admin allowlist — the
//      connector behaves EXACTLY as before, which is checked against the same
//      requests rather than asserted in prose;
//   3. every cross-tenant access writes an `admin_audit_log` row naming the
//      admin, the org or project, and the tool called — and reading a project
//      the admin genuinely belongs to writes nothing, so the trail only ever
//      holds the reads it exists to show.

import { describe, it, expect, beforeEach, vi } from "vitest"

// mcp-handlers pulls in the commit path (changesets-route -> commit.ts ->
// events/route -> broadcast.ts -> partyserver, which imports `cloudflare:*`).
// Stub it the way every MCP suite here does — nothing in this file commits.
vi.mock("partyserver", () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalReadRequest } from "../external/read-routes"
import { handleExternalChangesetsRequest } from "../external/changesets-route"
import { callTool, type McpToolResult } from "../external/mcp-handlers"
import { mintApiToken, validateApiCredential } from "../../../db/shared/api-credentials"
import type { ExternalEnv } from "../external/types"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"

// 1 ada is the platform admin and a member of NOTHING. 2 cass owns Customer
// Co and its project — the tenant ada is doing support work in. 3 dev is an
// ordinary (non-admin) user, for the "same grant, no allowlist row" case.
const ADA = 1
const CASS = 2
const DEV = 3

// 10 is ada's own org (so "support access widened a read" can be told apart
// from "ada was a member anyway"); 11 is the customer's.
const HOME = 10
const CUSTOMER = 11

let credSeq = 0

interface SeedCredentialOpts {
  userId: number
  /** The `support_access` grant — the consent-time opt-in. */
  supportAccess?: boolean
  /** Where the time box sits. Default: open. */
  window?: "open" | "closed" | "none"
  access?: "read" | "write"
}

/** Mint a real `aqk_` token and persist its hash, the way consent would. */
async function seedCredential(testDb: TestDb, opts: SeedCredentialOpts): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  credSeq += 1
  const id = `00000000-0000-0000-0000-${String(credSeq).padStart(12, "0")}`
  const until =
    opts.window === "closed"
      ? "now() - interval '1 minute'"
      : opts.window === "none"
        ? "NULL"
        : "now() + interval '6 hours'"
  await testDb.pg.query(
    `INSERT INTO api_credentials
       (id, user_id, name, token_prefix, token_hash, mode, access, support_access, support_access_until)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, $6, ${until})`,
    [id, String(opts.userId), tokenPrefix, tokenHash, opts.access ?? "read", opts.supportAccess ?? false],
  )
  return token
}

function env(testDb: TestDb) {
  return { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET }
}

function req(path: string, token?: string): Request {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`
  return new Request(`https://worker${path}`, { headers })
}

async function get(testDb: TestDb, path: string, token?: string): Promise<Response> {
  const res = await handleExternalReadRequest(req(path, token), env(testDb))
  if (!res) throw new Error(`no external route matched ${path}`)
  return res
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as unknown as { error: { code: string } }).error.code
}

/** Run an MCP tool with a real credential resolved from the token. */
async function tool(
  testDb: TestDb,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const cred = await validateApiCredential(testDb.db, token)
  if (!cred) throw new Error("credential did not validate")
  const result = (await callTool(name, args, env(testDb) as unknown as ExternalEnv, cred, token)) as McpToolResult
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

interface AuditRow {
  user_id: string
  action: string
  detail: string
}

async function auditRows(testDb: TestDb): Promise<{ action: string; userId: string; detail: Record<string, unknown> }[]> {
  const { rows } = await testDb.pg.query<AuditRow>(
    "SELECT user_id, action, detail FROM admin_audit_log ORDER BY id",
  )
  return rows.map((r) => ({
    action: r.action,
    userId: String(r.user_id),
    detail: JSON.parse(typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)) as Record<string, unknown>,
  }))
}

async function seedWorkspace(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES
       ($1, 'ada', 'ada@aquilla.app', 'h'),
       ($2, 'cass', 'cass@customer.example', 'h'),
       ($3, 'dev', 'dev@aquilla.app', 'h')`,
    [ADA, CASS, DEV],
  )
  // ada owns her own org; cass owns the customer's. ada is a member of
  // nothing in the customer's org — that is the whole point.
  await testDb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, 'Aquilla Home', $3), ($2, 'Customer Co', $4)`,
    [HOME, CUSTOMER, ADA, CASS],
  )
  await testDb.pg.query(
    `INSERT INTO org_members (org_id, user_id, role_level) VALUES ($1, $3, 700), ($2, $4, 700)`,
    [HOME, CUSTOMER, ADA, CASS],
  )
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES
       ('home-proj', 'Ada Home Project', $1, $3, NULL),
       ('cust-proj', 'Customer Project', $2, $4, NULL),
       ('cust-archived', 'Customer Old', $2, $4, now())`,
    [HOME, CUSTOMER, ADA, CASS],
  )
  // The platform-admin allowlist is the TABLE, matched by account email.
  await testDb.pg.query(`INSERT INTO platform_admins (email) VALUES ('ada@aquilla.app')`)
}

describe("AQU-2504 connector support access", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
    await seedWorkspace(testDb)
  })

  // -------------------------------------------------------------------------
  // 1. With the grant live: list and read any org and project.
  // -------------------------------------------------------------------------

  describe("with a live grant", () => {
    it("validates the credential with supportAccess on, and only with all three parts present", async () => {
      const live = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      expect((await validateApiCredential(testDb.db, live))?.supportAccess).toBe(true)

      // Grant without a window, and a window without a grant, are both inert —
      // neither column means anything on its own.
      const noWindow = await seedCredential(testDb, { userId: ADA, supportAccess: true, window: "none" })
      expect((await validateApiCredential(testDb.db, noWindow))?.supportAccess).toBeUndefined()
      const noGrant = await seedCredential(testDb, { userId: ADA, supportAccess: false })
      expect((await validateApiCredential(testDb.db, noGrant))?.supportAccess).toBeUndefined()
    })

    it("GET /orgs lists the customer's org, reported as platform/700", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { id: string; role: number; role_source: string }[] }
      expect(body.data.map((o) => o.id).sort()).toEqual([String(HOME), String(CUSTOMER)])
      expect(body.data.every((o) => o.role === 700 && o.role_source === "platform")).toBe(true)
    })

    it("GET /projects lists the customer's project but still excludes archived ones", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      const res = await get(testDb, "/api/v1/external/projects", token)
      const body = (await res.json()) as { data: { id: string; role_source: string }[] }
      expect(body.data.map((p) => p.id).sort()).toEqual(["cust-proj", "home-proj"])
      // Support access widens WHO counts as a member. It does not resurrect
      // trashed projects — that rule is orthogonal and stays.
      expect(body.data.map((p) => p.id)).not.toContain("cust-archived")
      expect(body.data.every((p) => p.role_source === "platform")).toBe(true)
    })

    it("GET /orgs/:orgId/projects reaches into the customer's org", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      const res = await get(testDb, `/api/v1/external/orgs/${CUSTOMER}/projects`, token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { id: string }[] }
      expect(body.data.map((p) => p.id)).toEqual(["cust-proj"])
    })

    it("GET /projects/:projectId opens the customer's project", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      const res = await get(testDb, "/api/v1/external/projects/cust-proj", token)
      expect(res.status).toBe(200)
      expect((await res.json()) as { id: string }).toMatchObject({ id: "cust-proj" })
    })

    it("the MCP adapter answers identically — list_orgs, list_projects and get_project", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      const orgs = (await tool(testDb, token, "list_orgs")) as { orgs: { id: string }[] }
      expect(orgs.orgs.map((o) => o.id).sort()).toEqual([String(HOME), String(CUSTOMER)])
      expect((await auditRows(testDb))[0].detail.tool).toBe("list_orgs")

      const projects = (await tool(testDb, token, "list_projects")) as { projects: { id: string }[] }
      expect(projects.projects.map((p) => p.id).sort()).toEqual(["cust-proj", "home-proj"])

      // get_project resolves the project role itself rather than through
      // scopeCredentialToProject, so it is the one most likely to drift.
      const project = await tool(testDb, token, "get_project", { projectId: "cust-proj" })
      expect(project).toMatchObject({ id: "cust-proj" })
    })
  })

  // -------------------------------------------------------------------------
  // 2. Without it: exactly today's behaviour.
  // -------------------------------------------------------------------------

  describe("without a live grant the connector behaves exactly as before", () => {
    const cases: { label: string; opts: SeedCredentialOpts }[] = [
      { label: "the time box has closed", opts: { userId: ADA, supportAccess: true, window: "closed" } },
      { label: "the grant was never given", opts: { userId: ADA, supportAccess: false } },
      {
        label: "the owner is not on the platform-admin allowlist",
        opts: { userId: DEV, supportAccess: true },
      },
    ]

    for (const { label, opts } of cases) {
      it(`${label}: sees only their own orgs and projects, and is refused the customer's`, async () => {
        const token = await seedCredential(testDb, opts)

        const orgs = (await (await get(testDb, "/api/v1/external/orgs", token)).json()) as {
          data: { id: string; role_source: string }[]
        }
        expect(orgs.data.map((o) => o.id)).not.toContain(String(CUSTOMER))
        expect(orgs.data.every((o) => o.role_source !== "platform")).toBe(true)

        const projects = (await (await get(testDb, "/api/v1/external/projects", token)).json()) as {
          data: { id: string }[]
        }
        expect(projects.data.map((p) => p.id)).not.toContain("cust-proj")

        const read = await get(testDb, "/api/v1/external/projects/cust-proj", token)
        expect(read.status).toBe(403)
        expect(await errorCode(read)).toBe("permission_denied")

        const scoped = await get(testDb, `/api/v1/external/orgs/${CUSTOMER}/projects`, token)
        const scopedBody = (await scoped.json()) as { data: { id: string }[] }
        expect(scopedBody.data).toEqual([])

        // And nothing is written to the admin audit log for any of it.
        expect(await auditRows(testDb)).toEqual([])
      })
    }

    it("the MCP adapter refuses the customer's project too, so neither adapter is the loose one", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true, window: "closed" })
      const result = await tool(testDb, token, "get_project", { projectId: "cust-proj" })
      expect(result).toMatchObject({ error: { code: "permission_denied" } })
    })

    it("a live grant is still refused once the allowlist row is removed, with no restart needed", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      expect((await get(testDb, "/api/v1/external/projects/cust-proj", token)).status).toBe(200)

      await testDb.pg.query("DELETE FROM platform_admins")

      const after = await get(testDb, "/api/v1/external/projects/cust-proj", token)
      expect(after.status).toBe(403)
    })
  })

  // -------------------------------------------------------------------------
  // 3. The audit trail.
  // -------------------------------------------------------------------------

  describe("audit trail", () => {
    it("names the admin, the project and the tool on a cross-tenant project read", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      await get(testDb, "/api/v1/external/projects/cust-proj", token)

      const rows = await auditRows(testDb)
      expect(rows).toHaveLength(1)
      expect(rows[0].action).toBe("connector.project.read")
      expect(rows[0].userId).toBe(String(ADA))
      expect(rows[0].detail).toMatchObject({
        projectId: "cust-proj",
        orgId: String(CUSTOMER),
        via: "connector",
        tool: "GET /api/v1/external/projects/cust-proj",
      })
      expect(rows[0].detail.credentialId).toBeTruthy()
    })

    it("records the MCP tool's own name, not the REST route it delegates to", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      await tool(testDb, token, "get_project", { projectId: "cust-proj" })
      const rows = await auditRows(testDb)
      expect(rows).toHaveLength(1)
      expect(rows[0].detail).toMatchObject({ tool: "get_project", projectId: "cust-proj" })
    })

    it("writes ONE row per enumeration, naming everything it returned", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      await get(testDb, "/api/v1/external/orgs", token)
      await get(testDb, "/api/v1/external/projects", token)

      const rows = await auditRows(testDb)
      expect(rows.map((r) => r.action)).toEqual(["connector.orgs.list", "connector.projects.list"])
      expect(rows[0].detail.orgIds).toEqual(expect.arrayContaining([String(HOME), String(CUSTOMER)]))
      expect(rows[1].detail.projectIds).toEqual(expect.arrayContaining(["cust-proj", "home-proj"]))
      // The trail names the adapter: these are REST routes, not MCP tools.
      expect(rows[0].detail.tool).toBe("GET /api/v1/external/orgs")
      expect(rows[1].detail.tool).toBe("GET /api/v1/external/projects")
    })

    it("writes NOTHING when the admin reads a project they genuinely belong to", async () => {
      const token = await seedCredential(testDb, { userId: ADA, supportAccess: true })
      const res = await get(testDb, "/api/v1/external/projects/home-proj", token)
      expect(res.status).toBe(200)
      // ada owns this org. Reading it through the connector is ordinary
      // member-scoped use, and logging it would bury the reads that matter.
      expect(await auditRows(testDb)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // The write ceiling.
  // -------------------------------------------------------------------------

  it("is read-only: a support credential cannot stage a changeset in the customer's project", async () => {
    // Consent mints these `access: 'read'` (auth-worker mcp-oauth.ts forces it),
    // which is the ceiling every write surface already honours. This pins that
    // the cross-tenant READ widening did not quietly open a write path.
    const token = await seedCredential(testDb, { userId: ADA, supportAccess: true, access: "read" })
    const cred = await validateApiCredential(testDb.db, token)
    expect(cred?.access).toBe("read")

    const res = await handleExternalChangesetsRequest(
      new Request("https://worker/api/v1/external/projects/cust-proj/changesets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            {
              kind: "SetTranslation",
              fileId: "f",
              cellId: "cell-1",
              laneId: "deflane1",
              value: "hello",
              valueHtml: "<p>hello</p>",
            },
          ],
        }),
      }),
      env(testDb) as unknown as ExternalEnv,
    )
    expect(res?.status).toBe(403)
    const body = (await res!.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("scope_denied")
    expect(body.error.message).toMatch(/read-only/)
  })
})
