// Tests for the org-scoped external reads (AQU-1236): GET /orgs,
// GET /orgs/:orgId/projects, GET /projects?orgId=, and cross-project
// GET /search?projectIds=a,b — plus their MCP mirrors (list_orgs,
// list_projects { orgId }, search_projects).
//
// The load-bearing assertions are the SCOPE ones: an org-scoped credential must
// not reach another org, a project-scoped credential must not widen to its org's
// siblings, and cross-project search must be all-or-nothing rather than quietly
// dropping projects the caller cannot see.

import { describe, it, expect, beforeEach, vi } from "vitest"

// mcp-handlers pulls in the commit path (changesets-route -> commit.ts ->
// events/route -> broadcast.ts -> partyserver, which imports `cloudflare:*`).
// Stub it exactly as the MCP and changeset suites do — none of these tests
// commit anything.
vi.mock("partyserver", () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalReadRequest } from "../external/read-routes"
import { MAX_SEARCH_PROJECTS } from "../external/search-reads"
import { callTool, type McpToolResult } from "../external/mcp-handlers"
import { MCP_TOOLS } from "../external/mcp-tools"
import { mintApiToken, validateApiCredential } from "../../../db/shared/api-credentials"
import type { ExternalEnv } from "../external/types"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"

// Users: 1 alice (owns Org Alpha), 2 bob (member of Alpha + Beta), 3 carol (owns Gamma).
const ALICE = 1
const BOB = 2
const CAROL = 3

// Orgs: 10 Alpha, 11 Beta, 12 Gamma.
const ALPHA = 10
const BETA = 11
const GAMMA = 12

let credSeq = 0

interface SeedCredentialOpts {
  userId: number
  orgId?: number | null
  projectId?: string | null
}

/** Mint a real `aqk_` token and persist its hash. */
async function seedCredential(testDb: TestDb, opts: SeedCredentialOpts): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  credSeq += 1
  const id = `00000000-0000-0000-0000-${String(credSeq).padStart(12, "0")}`
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, $6)`,
    [
      id,
      String(opts.userId),
      tokenPrefix,
      tokenHash,
      opts.orgId != null ? String(opts.orgId) : null,
      opts.projectId ?? null,
    ],
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

interface ErrorBody {
  error: { code: string; message: string }
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as unknown as ErrorBody).error.code
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
  const result = (await callTool(
    name,
    args,
    env(testDb) as unknown as ExternalEnv,
    cred,
    token,
  )) as McpToolResult
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

async function seedWorkspace(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES
       ($1, 'alice', 'alice@x.com', 'h'),
       ($2, 'bob', 'bob@x.com', 'h'),
       ($3, 'carol', 'carol@x.com', 'h')`,
    [ALICE, BOB, CAROL],
  )
  // alice owns Alpha; carol owns Beta and Gamma.
  await testDb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES
       ($1, 'Org Alpha', $4), ($2, 'Org Beta', $5), ($3, 'Org Gamma', $5)`,
    [ALPHA, BETA, GAMMA, ALICE, CAROL],
  )
  // bob is a MAINTAINER in Alpha and Beta (member, not owner).
  await testDb.pg.query(
    `INSERT INTO org_members (org_id, user_id, role_level) VALUES
       ($1, $4, 700), ($1, $5, 600), ($2, $5, 600), ($3, $6, 700)`,
    [ALPHA, BETA, GAMMA, ALICE, BOB, CAROL],
  )

  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES
       ('proj-a', 'Alpha One', $1, $4, NULL),
       ('proj-b', 'Alpha Two', $1, $4, NULL),
       ('proj-archived', 'Alpha Old', $1, $4, now()),
       ('proj-beta', 'Beta One', $2, $5, NULL),
       ('proj-gamma', 'Gamma One', $3, $6, NULL),
       ('proj-personal', 'Alice Solo', NULL, $4, NULL)`,
    [ALPHA, BETA, GAMMA, ALICE, BOB, CAROL],
  )

  // Searchable content in two Alpha projects, so a cross-project search has
  // something to merge.
  for (const [project, file, value] of [
    ["proj-a", "file-a", "In the beginning was the Word"],
    ["proj-b", "file-b", "The beginning of wisdom"],
  ] as const) {
    await testDb.pg.query(
      `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, 'Book', $3)`,
      [file, project, `evt-file-${file}`],
    )
    await testDb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
       VALUES ($1, $2, 'cell-1', 'source', $3, $4, 1000, 5)`,
      [project, file, value, `evt-${file}`],
    )
  }
}

describe("org-scoped external reads (AQU-1236)", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
    await seedWorkspace(testDb)
  })

  // -------------------------------------------------------------------------
  // GET /orgs
  // -------------------------------------------------------------------------

  describe("GET /orgs", () => {
    it("lists every org the credential's user belongs to, with their role", async () => {
      const token = await seedCredential(testDb, { userId: BOB })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { id: string; name: string; role: number; role_source: string }[] }
      expect(body.data.map((o) => o.id).sort()).toEqual([String(ALPHA), String(BETA)])
      expect(body.data.every((o) => o.role === 600)).toBe(true)
      expect(body.data.every((o) => o.role_source === "member")).toBe(true)
    })

    it("reports the owner's role as owner/700", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      const body = (await res.json()) as { data: { id: string; role: number; role_source: string }[] }
      expect(body.data).toEqual([{ id: String(ALPHA), name: "Org Alpha", role: 700, role_source: "owner" }])
    })

    it("never includes an org the user does not belong to", async () => {
      const token = await seedCredential(testDb, { userId: BOB })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      const body = (await res.json()) as { data: { id: string }[] }
      expect(body.data.map((o) => o.id)).not.toContain(String(GAMMA))
    })

    it("an org-scoped credential sees only its own org", async () => {
      const token = await seedCredential(testDb, { userId: BOB, orgId: BETA })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      const body = (await res.json()) as { data: { id: string }[] }
      expect(body.data.map((o) => o.id)).toEqual([String(BETA)])
    })

    it("a project-scoped credential sees only the org owning that project", async () => {
      const token = await seedCredential(testDb, { userId: BOB, projectId: "proj-beta" })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      const body = (await res.json()) as { data: { id: string }[] }
      expect(body.data.map((o) => o.id)).toEqual([String(BETA)])
    })

    it("a credential scoped to a personal (org-less) project sees no orgs", async () => {
      const token = await seedCredential(testDb, { userId: ALICE, projectId: "proj-personal" })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toEqual([])
    })

    it("exposes no PII beyond ids, names and the caller's own role", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const res = await get(testDb, "/api/v1/external/orgs", token)
      const body = (await res.json()) as { data: Record<string, unknown>[] }
      expect(Object.keys(body.data[0]).sort()).toEqual(["id", "name", "role", "role_source"])
    })

    it("rejects a missing credential", async () => {
      const res = await get(testDb, "/api/v1/external/orgs")
      expect(res.status).toBe(401)
      expect(await errorCode(res)).toBe("permission_denied")
    })
  })

  // -------------------------------------------------------------------------
  // GET /orgs/:orgId/projects  and  GET /projects?orgId=
  // -------------------------------------------------------------------------

  describe("GET /orgs/:orgId/projects", () => {
    it("lists that org's live projects only", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const res = await get(testDb, `/api/v1/external/orgs/${ALPHA}/projects`, token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { id: string; org_id: string }[] }
      // proj-archived is archived; proj-personal has no org; proj-beta/-gamma
      // are other orgs.
      expect(body.data.map((p) => p.id).sort()).toEqual(["proj-a", "proj-b"])
      expect(body.data.every((p) => p.org_id === String(ALPHA))).toBe(true)
    })

    it("?orgId= on /projects is the same filter", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const res = await get(testDb, `/api/v1/external/projects?orgId=${ALPHA}`, token)
      const body = (await res.json()) as { data: { id: string }[] }
      expect(body.data.map((p) => p.id).sort()).toEqual(["proj-a", "proj-b"])
    })

    it("refuses an org outside an org-scoped credential's scope", async () => {
      const token = await seedCredential(testDb, { userId: BOB, orgId: BETA })
      const res = await get(testDb, `/api/v1/external/orgs/${ALPHA}/projects`, token)
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe("scope_denied")
    })

    it("refuses an out-of-scope ?orgId= on /projects too", async () => {
      const token = await seedCredential(testDb, { userId: BOB, orgId: BETA })
      const res = await get(testDb, `/api/v1/external/projects?orgId=${ALPHA}`, token)
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe("scope_denied")
    })

    it("gives a project-scoped credential exactly its one project — no widening", async () => {
      const token = await seedCredential(testDb, { userId: ALICE, projectId: "proj-a" })
      const res = await get(testDb, `/api/v1/external/orgs/${ALPHA}/projects`, token)
      const body = (await res.json()) as { data: { id: string }[] }
      expect(body.data.map((p) => p.id)).toEqual(["proj-a"])
    })

    it("refuses an org that does not own a project-scoped credential's project", async () => {
      const token = await seedCredential(testDb, { userId: BOB, projectId: "proj-beta" })
      const res = await get(testDb, `/api/v1/external/orgs/${ALPHA}/projects`, token)
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe("scope_denied")
    })

    it("?orgId= answers an out-of-scope org identically — scope_denied, not an empty list", async () => {
      // Both spellings of "this org's projects" must agree, or one of them makes
      // "not yours" look like "empty".
      const token = await seedCredential(testDb, { userId: BOB, projectId: "proj-beta" })
      const viaPath = await get(testDb, `/api/v1/external/orgs/${ALPHA}/projects`, token)
      const viaQuery = await get(testDb, `/api/v1/external/projects?orgId=${ALPHA}`, token)
      expect(viaQuery.status).toBe(viaPath.status)
      expect(await errorCode(viaQuery)).toBe("scope_denied")
    })

    it("returns an empty list for an org the user has no membership in", async () => {
      // In scope (unscoped credential) but not a member — visible-to-nobody,
      // not an error, exactly like /projects.
      const token = await seedCredential(testDb, { userId: BOB })
      const res = await get(testDb, `/api/v1/external/orgs/${GAMMA}/projects`, token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: unknown[] }
      expect(body.data).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // GET /search?projectIds=
  // -------------------------------------------------------------------------

  describe("GET /search (cross-project)", () => {
    it("returns per-project-attributed results from several projects in one call", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const res = await get(
        testDb,
        "/api/v1/external/search?q=beginning&projectIds=proj-a,proj-b",
        token,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { projectId: string; cellId: string; value: string }[]
        projectIds: string[]
      }
      expect(body.projectIds).toEqual(["proj-a", "proj-b"])
      expect(body.data.map((r) => r.projectId).sort()).toEqual(["proj-a", "proj-b"])
      expect(body.data.every((r) => /beginning/i.test(r.value))).toBe(true)
    })

    it("fails the whole call when one listed project is out of the credential's org scope", async () => {
      const token = await seedCredential(testDb, { userId: BOB, orgId: BETA })
      const res = await get(
        testDb,
        "/api/v1/external/search?q=beginning&projectIds=proj-beta,proj-a",
        token,
      )
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe("scope_denied")
    })

    it("fails the whole call for a project-scoped credential naming a second project", async () => {
      const token = await seedCredential(testDb, { userId: ALICE, projectId: "proj-a" })
      const res = await get(
        testDb,
        "/api/v1/external/search?q=beginning&projectIds=proj-a,proj-b",
        token,
      )
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe("scope_denied")
    })

    it("fails the whole call when the caller has no membership on one listed project", async () => {
      const token = await seedCredential(testDb, { userId: BOB })
      const res = await get(
        testDb,
        "/api/v1/external/search?q=beginning&projectIds=proj-beta,proj-gamma",
        token,
      )
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe("permission_denied")
    })

    it("404s the whole call on an unknown project id", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const res = await get(
        testDb,
        "/api/v1/external/search?q=beginning&projectIds=proj-a,nope",
        token,
      )
      expect(res.status).toBe(404)
      expect(await errorCode(res)).toBe("not_found")
    })

    it("requires projectIds and q", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      expect(await errorCode(await get(testDb, "/api/v1/external/search?q=x", token))).toBe(
        "validation_failed",
      )
      expect(
        await errorCode(await get(testDb, "/api/v1/external/search?projectIds=proj-a", token)),
      ).toBe("validation_failed")
    })

    it("caps the number of projects per call", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const ids = Array.from({ length: MAX_SEARCH_PROJECTS + 1 }, (_, i) => `p${i}`).join(",")
      const res = await get(testDb, `/api/v1/external/search?q=x&projectIds=${ids}`, token)
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe("validation_failed")
    })

    it("charges the search budget once per project searched", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      await get(testDb, "/api/v1/external/search?q=beginning&projectIds=proj-a,proj-b", token)
      const events = await testDb.rows<{ kind: string }>("auth_rate_limit_events")
      expect(events.filter((e) => e.kind === "external_search").length).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // MCP mirrors
  // -------------------------------------------------------------------------

  describe("MCP adapter", () => {
    it("publishes list_orgs and search_projects in the tool catalog", async () => {
      const names = MCP_TOOLS.map((t) => t.name)
      expect(names).toContain("list_orgs")
      expect(names).toContain("search_projects")
    })

    it("list_orgs mirrors the REST route", async () => {
      const token = await seedCredential(testDb, { userId: BOB, orgId: BETA })
      const body = await tool(testDb, token, "list_orgs")
      expect(body.orgs).toEqual([{ id: String(BETA), name: "Org Beta", role: 600, role_source: "member" }])
    })

    it("list_projects accepts an orgId filter", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const body = (await tool(testDb, token, "list_projects", { orgId: String(ALPHA) })) as {
        projects: { id: string }[]
      }
      expect(body.projects.map((p) => p.id).sort()).toEqual(["proj-a", "proj-b"])
    })

    it("list_projects refuses an orgId outside the credential's scope", async () => {
      const token = await seedCredential(testDb, { userId: BOB, orgId: BETA })
      const body = (await tool(testDb, token, "list_projects", { orgId: String(ALPHA) })) as unknown as ErrorBody
      expect(body.error.code).toBe("scope_denied")
    })

    it("search_projects returns attributed cross-project results", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const body = (await tool(testDb, token, "search_projects", {
        q: "beginning",
        projectIds: ["proj-a", "proj-b"],
      })) as { data: { projectId: string }[] }
      expect(body.data.map((r) => r.projectId).sort()).toEqual(["proj-a", "proj-b"])
    })

    it("search_projects propagates the strict scope failure", async () => {
      const token = await seedCredential(testDb, { userId: ALICE, projectId: "proj-a" })
      const body = (await tool(testDb, token, "search_projects", {
        q: "beginning",
        projectIds: ["proj-a", "proj-b"],
      })) as unknown as ErrorBody
      expect(body.error.code).toBe("scope_denied")
    })

    it("search_projects validates its arguments", async () => {
      const token = await seedCredential(testDb, { userId: ALICE })
      const noIds = (await tool(testDb, token, "search_projects", { q: "x" })) as unknown as ErrorBody
      expect(noIds.error.code).toBe("validation_failed")
      const noQ = (await tool(testDb, token, "search_projects", { projectIds: ["proj-a"] })) as unknown as ErrorBody
      expect(noQ.error.code).toBe("validation_failed")
    })
  })
})
