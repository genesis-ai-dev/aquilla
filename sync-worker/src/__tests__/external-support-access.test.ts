// AQU-2504 — connector SUPPORT ACCESS on the external read tier.
//
// The connector used to be strictly member-scoped: orgs-list.ts, projects-list.ts
// and read-auth.ts all resolved membership and nothing else, so a support
// engineer could not look at the project a customer was messaging them about.
// A platform admin may now opt into a time-boxed, audited, cross-tenant grant
// at connector consent (auth-worker/src/routes/mcp-oauth.ts, covered by its own
// suite). This suite covers what that grant does once the token exists — reads
// AND WRITES (the writes half landed second; see the `writes` block below).
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
//      holds the reads it exists to show;
//   4. a support WRITE lands in the customer's project, is audited as a write,
//      and is attributed to the platform admin in the event's provenance so the
//      org's own members can see who made the change.

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
import { mintInternalSyncToken } from "../external/token-bridge"
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
  /** Credential org scope. Unset (the support-access shape) means every org. */
  orgId?: number
}

/** Mint a real `aqk_` token and persist its hash, the way consent would.
 *  Returns the credential id too, which the write tests need to seed the
 *  ask-mode approval a commit consumes. */
async function seedCredentialWithId(
  testDb: TestDb,
  opts: SeedCredentialOpts,
): Promise<{ token: string; credentialId: string }> {
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
       (id, user_id, name, token_prefix, token_hash, mode, access, org_id, support_access, support_access_until)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, $6, $7, ${until})`,
    [
      id,
      String(opts.userId),
      tokenPrefix,
      tokenHash,
      opts.access ?? "read",
      opts.orgId === undefined ? null : String(opts.orgId),
      opts.supportAccess ?? false,
    ],
  )
  return { token, credentialId: id }
}

async function seedCredential(testDb: TestDb, opts: SeedCredentialOpts): Promise<string> {
  return (await seedCredentialWithId(testDb, opts)).token
}

/** The stored credential id behind a token. */
async function credentialIdOf(testDb: TestDb, token: string): Promise<string> {
  const cred = await validateApiCredential(testDb.db, token)
  if (!cred) throw new Error("credential did not validate")
  return cred.credentialId
}

/** The claims of a minted internal sync token. Signature-checked elsewhere;
 *  here we only need to read what was stamped. */
function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1]!
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>
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

interface PrepareBody {
  changeset: { id: string; status: string; autonomyMode: string }
  digest: string
}

interface CommitBody {
  receipt: { fileId?: string; appliedCount?: number }
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

  it("a READ-ONLY support credential still cannot stage a changeset, support access or not", async () => {
    // The writes half (AQU-2504) lifted the forced `access: 'read'` at consent,
    // but NOT this ceiling: support access widens which PROJECTS a credential
    // reaches, never what the credential itself may do. A support engineer who
    // connected a read-only host gets the cross-tenant reads and nothing more.
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

  // -------------------------------------------------------------------------
  // 4. Writes (AQU-2504, the writes half).
  //
  // The customer's project is built through the real agent API AS THE CUSTOMER
  // (cass, who owns the org), so the thing ada writes into is a genuine
  // project with real lanes, a real file and a real cell — not a hand-seeded
  // row that might not resemble one. Then ada, a member of nothing here,
  // writes into it on support access alone.
  // -------------------------------------------------------------------------

  describe("writes", () => {
    const WRITE_PROJECT = "cust-write"

    function changesetsUrl(projectId: string): string {
      return `https://worker/api/v1/external/projects/${projectId}/changesets`
    }

    /** Stage a changeset. */
    async function prepare(
      token: string,
      projectId: string,
      commands: unknown[],
    ): Promise<{ status: number; body: PrepareBody & { error?: { code: string; message: string } } }> {
      const res = (await handleExternalChangesetsRequest(
        new Request(changesetsUrl(projectId), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ commands }),
        }),
        env(testDb) as unknown as ExternalEnv,
      ))!
      return { status: res.status, body: (await res.json()) as PrepareBody & { error?: { code: string; message: string } } }
    }

    /** Commit a staged changeset, seeding the approval an ask-mode plan needs. */
    async function commit(
      token: string,
      projectId: string,
      credentialId: string,
      userId: number,
      prep: PrepareBody,
    ): Promise<{ status: number; body: CommitBody & { error?: { code: string; message: string } } }> {
      if (prep.changeset.autonomyMode === "ask") {
        await testDb.db
          .prepare(
            `INSERT INTO changeset_confirmations
               (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          )
          .bind(
            `conf-${prep.changeset.id}`,
            prep.changeset.id,
            String(userId),
            credentialId,
            prep.digest,
            new Date(Date.now() + 60_000).toISOString(),
          )
          .run()
      }
      const res = (await handleExternalChangesetsRequest(
        new Request(`${changesetsUrl(projectId)}/${prep.changeset.id}/commit`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env(testDb) as unknown as ExternalEnv,
      ))!
      return { status: res.status, body: (await res.json()) as CommitBody & { error?: { code: string; message: string } } }
    }

    /** Prepare + commit; both must succeed. */
    async function apply(
      token: string,
      projectId: string,
      credentialId: string,
      userId: number,
      commands: unknown[],
    ): Promise<CommitBody> {
      const prep = await prepare(token, projectId, commands)
      expect(prep.status, JSON.stringify(prep.body)).toBe(200)
      const done = await commit(token, projectId, credentialId, userId, prep.body)
      expect(done.status, JSON.stringify(done.body)).toBe(200)
      return done.body
    }

    /**
     * Build the customer's project as the customer: a project in their org, one
     * target lane, one imported file with one cell. Returns what a write needs
     * to address that cell.
     */
    async function seedCustomerProject(): Promise<{
      fileId: string
      cellId: string
      laneId: string
    }> {
      const { token, credentialId } = await seedCredentialWithId(testDb, {
        userId: CASS,
        access: "write",
        orgId: CUSTOMER,
      })
      await apply(token, WRITE_PROJECT, credentialId, CASS, [
        {
          kind: "CreateProject",
          name: "Customer Write Project",
          orgId: CUSTOMER,
          lanes: [
            { role: "source", language: "en" },
            { role: "target", language: "fr" },
          ],
        },
      ])
      const lanes = await testDb.pg.query<{ id: string }>(
        `SELECT id FROM lanes WHERE project_id = $1 AND role = 'target'`,
        [WRITE_PROJECT],
      )
      const laneId = lanes.rows[0]!.id
      const imported = await apply(token, WRITE_PROJECT, credentialId, CASS, [
        {
          kind: "PlanImport",
          fileName: "gen.txt",
          fileType: "txt",
          cells: [{ ref: "1:1", content: "In the beginning" }],
        },
      ])
      const fileId = imported.receipt.fileId!
      const cells = await testDb.pg.query<{ cell_id: string }>(
        `SELECT cell_id FROM cells
          WHERE project_id = $1 AND file_id = $2 AND side = 'source'
          ORDER BY cell_id`,
        [WRITE_PROJECT, fileId],
      )
      return { fileId, cellId: cells.rows[0]!.cell_id, laneId }
    }

    function setTranslation(
      fileId: string,
      cellId: string,
      laneId: string,
      value: string,
    ): Record<string, unknown> {
      return {
        kind: "SetTranslation",
        fileId,
        cellId,
        laneId,
        value,
        valueHtml: `<p>${value}</p>`,
      }
    }

    /** The target cell's committed text, or null when nothing landed. */
    async function translationOf(cellId: string, laneId: string): Promise<string | null> {
      const { rows } = await testDb.pg.query<{ value: string | null }>(
        `SELECT value FROM cells
          WHERE project_id = $1 AND cell_id = $2 AND lane_id = $3 AND side = 'target'`,
        [WRITE_PROJECT, cellId, laneId],
      )
      return rows[0]?.value ?? null
    }

    /** The provenance envelope stamped on the cell's latest target event. */
    async function latestTargetProvenance(
      cellId: string,
    ): Promise<Record<string, unknown> | null> {
      const { rows } = await testDb.pg.query<{ provenance: unknown }>(
        `SELECT provenance FROM events
          WHERE project_id = $1 AND cell_id = $2 AND kind = 'target.cell.commit'
          ORDER BY server_seq DESC LIMIT 1`,
        [WRITE_PROJECT, cellId],
      )
      const raw = rows[0]?.provenance
      if (raw == null) return null
      return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
    }

    it("a write-capable support credential writes into the customer's project", async () => {
      const seeded = await seedCustomerProject()
      // ada is a member of NOTHING in the customer's org — this is the whole
      // point. Without support access the same call is a 403 (asserted below).
      const { token, credentialId } = await seedCredentialWithId(testDb, {
        userId: ADA,
        supportAccess: true,
        access: "write",
      })
      await apply(token, WRITE_PROJECT, credentialId, ADA, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])
      expect(await translationOf(seeded.cellId, seeded.laneId)).toBe("Au commencement")
    })

    it("attributes the write to the platform admin in the event's provenance", async () => {
      const seeded = await seedCustomerProject()
      const { token, credentialId } = await seedCredentialWithId(testDb, {
        userId: ADA,
        supportAccess: true,
        access: "write",
      })
      await apply(token, WRITE_PROJECT, credentialId, ADA, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])

      // The ticket: "a new translation or a validation shows that a platform
      // admin did it", for the org's own members, in the normal places —
      // `events.provenance` being the one column "what touched this cell" is
      // read from.
      const provenance = await latestTargetProvenance(seeded.cellId)
      expect(provenance).not.toBeNull()
      expect(provenance!.support_access).toEqual({ platform_admin: true })
      expect((provenance!.human_authority as { user_id: string }).user_id).toBe(String(ADA))
    })

    it("marks nothing when a MEMBER writes — the marking means platform power, not agent", async () => {
      const seeded = await seedCustomerProject()
      const { token, credentialId } = await seedCredentialWithId(testDb, {
        userId: CASS,
        access: "write",
        orgId: CUSTOMER,
      })
      await apply(token, WRITE_PROJECT, credentialId, CASS, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])
      const provenance = await latestTargetProvenance(seeded.cellId)
      expect(provenance).not.toBeNull()
      expect(provenance!.support_access).toBeUndefined()
    })

    it("audits the write as a write, naming the admin, the project, the org and the tool", async () => {
      const seeded = await seedCustomerProject()
      // Reads taken while building the fixture were cass's own and logged
      // nothing; start the write from a clean trail.
      await testDb.pg.query("DELETE FROM admin_audit_log")
      const { token, credentialId } = await seedCredentialWithId(testDb, {
        userId: ADA,
        supportAccess: true,
        access: "write",
      })
      await apply(token, WRITE_PROJECT, credentialId, ADA, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])

      const rows = await auditRows(testDb)
      const writes = rows.filter((r) => r.action === "connector.project.write")
      expect(writes.length).toBe(1)
      expect(writes[0]!.userId).toBe(String(ADA))
      expect(writes[0]!.detail.projectId).toBe(WRITE_PROJECT)
      expect(writes[0]!.detail.orgId).toBe(String(CUSTOMER))
      expect(writes[0]!.detail.credentialId).toBe(credentialId)
      expect(writes[0]!.detail.via).toBe("connector")
      expect(typeof writes[0]!.detail.tool).toBe("string")
      // The write token is minted per (project, file), so the row names the
      // file — several rows from one multi-file commit each say something
      // distinct instead of repeating "wrote in this project".
      expect(writes[0]!.detail.fileId).toBe(seeded.fileId)

      // The prepare and commit gates that led here are cross-tenant READS of
      // project state, recorded as such — so the trail distinguishes "looked"
      // from "changed" instead of counting one act as three writes.
      expect(rows.some((r) => r.action === "connector.project.read")).toBe(true)
    })

    it("refuses the write once the window closes, exactly as before the grant existed", async () => {
      const seeded = await seedCustomerProject()
      const { token } = await seedCredentialWithId(testDb, {
        userId: ADA,
        supportAccess: true,
        access: "write",
        window: "closed",
      })
      const prep = await prepare(token, WRITE_PROJECT, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])
      expect(prep.status).toBe(403)
      expect(prep.body.error?.code).toBe("permission_denied")
      expect(await translationOf(seeded.cellId, seeded.laneId)).toBeNull()
    })

    it("refuses the write for a grant-holder who is not on the platform-admin allowlist", async () => {
      const seeded = await seedCustomerProject()
      // dev holds an identical grant inside an open window and is NOT in
      // platform_admins — the allowlist is the load-bearing condition.
      const { token } = await seedCredentialWithId(testDb, {
        userId: DEV,
        supportAccess: true,
        access: "write",
      })
      const prep = await prepare(token, WRITE_PROJECT, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])
      expect(prep.status).toBe(403)
      expect(await translationOf(seeded.cellId, seeded.laneId)).toBeNull()
      expect(await auditRows(testDb)).toEqual([])
    })

    it("refuses the write for an admin with no support grant at all", async () => {
      const seeded = await seedCustomerProject()
      const { token } = await seedCredentialWithId(testDb, {
        userId: ADA,
        supportAccess: false,
        access: "write",
      })
      const prep = await prepare(token, WRITE_PROJECT, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])
      expect(prep.status).toBe(403)
      expect(await translationOf(seeded.cellId, seeded.laneId)).toBeNull()
    })

    it("puts the `support` claim on the token ONLY when support access opened the project", async () => {
      // The claim is the whole exemption: it is what stands the write
      // perimeter's live membership re-check down. It is minted in exactly one
      // place (token-bridge.ts) and is signature-protected like `src`, so the
      // thing worth pinning is its TRIGGER — that a genuine member's external
      // token never carries it, and a support credential's does.
      const seeded = await seedCustomerProject()

      const member = await validateApiCredential(
        testDb.db,
        (await seedCredentialWithId(testDb, { userId: CASS, access: "write", orgId: CUSTOMER })).token,
      )
      const memberToken = await mintInternalSyncToken(
        { SYNC_SECRET_KEY: SECRET },
        testDb.db,
        member!,
        WRITE_PROJECT,
        seeded.fileId,
      )
      expect(decodeClaims(memberToken).support).toBeUndefined()
      expect(decodeClaims(memberToken).src).toBe("external")

      const admin = await validateApiCredential(
        testDb.db,
        (await seedCredentialWithId(testDb, { userId: ADA, supportAccess: true, access: "write" })).token,
      )
      const supportToken = await mintInternalSyncToken(
        { SYNC_SECRET_KEY: SECRET },
        testDb.db,
        admin!,
        WRITE_PROJECT,
        seeded.fileId,
      )
      const claims = decodeClaims(supportToken)
      expect(claims.support).toBe(true)
      // Still an EXTERNAL token, not a platform one — the exemption is scoped
      // to the membership gate and must not pick up the blanket ADMIN_EMAILS
      // exemption that `src: 'platform'` carries.
      expect(claims.src).toBe("external")
      expect(claims.role).toBe(700)
    })

    it("refuses the write when the audit row cannot be written — fail closed", async () => {
      // "Every cross-org access writes an audit row" is not satisfied by
      // "usually". An unrecordable cross-tenant write must not apply, so the
      // write audit throws where the read audit swallows.
      const seeded = await seedCustomerProject()
      const { token } = await seedCredentialWithId(testDb, {
        userId: ADA,
        supportAccess: true,
        access: "write",
      })
      await testDb.pg.query("DROP TABLE admin_audit_log")
      const prep = await prepare(token, WRITE_PROJECT, [
        setTranslation(seeded.fileId, seeded.cellId, seeded.laneId, "Au commencement"),
      ])
      // The staging gate's own audit is best-effort, so prepare still succeeds;
      // the WRITE is what must not land.
      if (prep.status === 200) {
        const done = await commit(
          token,
          WRITE_PROJECT,
          await credentialIdOf(testDb, token),
          ADA,
          prep.body,
        )
        expect(done.status).not.toBe(200)
      }
      expect(await translationOf(seeded.cellId, seeded.laneId)).toBeNull()
    })
  })
})
