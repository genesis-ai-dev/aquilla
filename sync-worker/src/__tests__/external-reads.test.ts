// Tests for the external read surface (AGENT-API §4 read tier — AQU-533 W1-C).
//
// `api_credentials` doesn't exist in db/postgres/schema.sql yet (W1-A owns
// migration 0054 in parallel) — SWARM-TODO(W1-C): drop the CREATE TABLE
// below once that migration merges; the shape here matches the COMMON
// contract description in docs/AGENT-API.md §2.

import { describe, it, expect, beforeEach } from "vitest"
import { handleExternalReadRequest } from "../external/read-routes"
import { hashApiToken } from "../external/__stubs__/api-credentials"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"

async function createApiCredentialsTable(testDb: TestDb) {
  await testDb.pg.exec(`
    CREATE TABLE IF NOT EXISTS api_credentials (
      id            TEXT PRIMARY KEY,
      user_id       BIGINT NOT NULL,
      org_id        BIGINT,
      project_id    TEXT,
      token_hash    TEXT NOT NULL UNIQUE,
      autonomy_mode TEXT NOT NULL DEFAULT 'ask',
      revoked_at    TIMESTAMPTZ,
      expires_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT now()
    );
  `)
}

interface SeedCredentialOpts {
  id: string
  token: string
  userId: number
  orgId?: number | null
  projectId?: string | null
  revoked?: boolean
  expired?: boolean
}

async function seedCredential(testDb: TestDb, opts: SeedCredentialOpts) {
  const tokenHash = await hashApiToken(opts.token)
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, org_id, project_id, token_hash, autonomy_mode, revoked_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'act', $6, $7)`,
    [
      opts.id,
      opts.userId,
      opts.orgId ?? null,
      opts.projectId ?? null,
      tokenHash,
      opts.revoked ? new Date().toISOString() : null,
      opts.expired ? new Date(Date.now() - 60_000).toISOString() : null,
    ],
  )
}

function env(testDb: TestDb) {
  return { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET }
}

function req(path: string, token?: string): Request {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`
  return new Request(`https://worker${path}`, { headers })
}

async function seedProjectAndCells(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'owner', 'owner@x.com', 'h')`,
  )
  await testDb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'Project A', 10, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-b', 'Project B', 11, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-a', 2, 400)`,
  )
  await testDb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-x', 'proj-a', 'Genesis', 'evt-file-1')`,
  )
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
     VALUES ('proj-a', 'file-x', 'cell-1', 'source', 'In the beginning', 'evt-1', 1000, 3)`,
  )
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
     VALUES ('proj-a', 'file-x', 'cell-1', 'target', 'Au commencement', 'evt-2', 2000, 2)`,
  )
  await testDb.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES ('evt-1', 1, 'proj-a', 'file-x', 'cell-1', 'source.cell.create', 'importer', '{"value":"In the beginning"}', 100, 100, NULL, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES ('evt-2', 1, 'proj-a', 'file-x', 'cell-1', 'target.cell.create', 'alice', '{"value":"Au commencement"}', 200, 200, NULL, 2)`,
  )
}

describe("external read surface", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
    await createApiCredentialsTable(testDb)
    await seedProjectAndCells(testDb)
  })

  it("returns null for unrelated paths", async () => {
    const res = await handleExternalReadRequest(req("/admin/whatever"), env(testDb))
    expect(res).toBeNull()
  })

  describe("search", () => {
    it("scoped member credential can search cells", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_member", userId: 2, projectId: "proj-a" })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/search?q=beginning", "aqk_member"),
        env(testDb),
      )
      expect(res).not.toBeNull()
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { data: unknown[]; nextCursor: string | null }
      expect(body.data.length).toBeGreaterThan(0)
      expect(body.nextCursor).toBeNull()
    })

    it("missing q is validation_failed", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_member", userId: 2, projectId: "proj-a" })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/search", "aqk_member"),
        env(testDb),
      )
      const body = (await res!.json()) as { error: { code: string } }
      expect(res!.status).toBe(400)
      expect(body.error.code).toBe("validation_failed")
    })
  })

  describe("cells + files reads", () => {
    it("scoped member credential reads files", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_member", userId: 2, projectId: "proj-a" })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files", "aqk_member"),
        env(testDb),
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { data: Array<{ fileId: string }>; nextCursor: string | null }
      expect(body.data).toHaveLength(1)
      expect(body.data[0].fileId).toBe("file-x")
    })

    it("scoped member credential reads cells for a file", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_member", userId: 2, projectId: "proj-a" })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files/file-x/cells", "aqk_member"),
        env(testDb),
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { data: Array<{ cellId: string; side: string }>; nextCursor: string | null }
      expect(body.data).toHaveLength(2)
      expect(body.data.map((c) => c.side).sort()).toEqual(["source", "target"])
    })
  })

  describe("cell history", () => {
    it("scoped member credential reads cell history newest-first", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_member", userId: 2, projectId: "proj-a" })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/cells/cell-1/history", "aqk_member"),
        env(testDb),
      )
      expect(res!.status).toBe(200)
      const body = (await res!.json()) as { data: Array<{ id: string; serverSeq: number }>; nextCursor: string | null }
      expect(body.data.map((e) => e.id)).toEqual(["evt-2", "evt-1"])
    })
  })

  describe("permission and scope errors", () => {
    it("wrong-project-scoped credential -> scope_denied", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_scoped", userId: 2, projectId: "proj-b" })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files", "aqk_scoped"),
        env(testDb),
      )
      expect(res!.status).toBe(403)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("scope_denied")
    })

    it("wrong-org-scoped credential -> scope_denied", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_org", userId: 2, orgId: 999 })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files", "aqk_org"),
        env(testDb),
      )
      expect(res!.status).toBe(403)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("scope_denied")
    })

    it("revoked credential -> permission_denied", async () => {
      await seedCredential(testDb, {
        id: "cred-1",
        token: "aqk_revoked",
        userId: 2,
        projectId: "proj-a",
        revoked: true,
      })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files", "aqk_revoked"),
        env(testDb),
      )
      expect(res!.status).toBe(401)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("permission_denied")
    })

    it("expired credential -> permission_denied", async () => {
      await seedCredential(testDb, {
        id: "cred-1",
        token: "aqk_expired",
        userId: 2,
        projectId: "proj-a",
        expired: true,
      })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files", "aqk_expired"),
        env(testDb),
      )
      expect(res!.status).toBe(401)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("permission_denied")
    })

    it("non-member user's credential -> permission_denied", async () => {
      await testDb.pg.query(
        `INSERT INTO users (id, username, email, password_hash) VALUES (3, 'stranger', 'stranger@x.com', 'h')`,
      )
      await seedCredential(testDb, { id: "cred-1", token: "aqk_stranger", userId: 3 })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files", "aqk_stranger"),
        env(testDb),
      )
      expect(res!.status).toBe(403)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("permission_denied")
    })

    it("missing bearer token -> permission_denied", async () => {
      const res = await handleExternalReadRequest(req("/api/v1/external/projects/proj-a/files"), env(testDb))
      expect(res!.status).toBe(401)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("permission_denied")
    })

    it("unknown project -> not_found", async () => {
      await seedCredential(testDb, { id: "cred-1", token: "aqk_member", userId: 2, projectId: "proj-a" })
      const res = await handleExternalReadRequest(
        req("/api/v1/external/projects/does-not-exist/files", "aqk_member"),
        env(testDb),
      )
      expect(res!.status).toBe(404)
      const body = (await res!.json()) as { error: { code: string } }
      expect(body.error.code).toBe("not_found")
    })
  })

  describe("pagination", () => {
    it("returns stable pages and a null terminal cursor", async () => {
      // Add a couple more source/target cell pairs so pagination has >1 page.
      for (const n of [2, 3, 4]) {
        await testDb.pg.query(
          `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
           VALUES ('proj-a', 'file-x', $1, 'source', $2, $3, $4, 1)`,
          [`cell-${n}`, `source text ${n}`, `evt-src-${n}`, 1000 + n],
        )
      }
      await seedCredential(testDb, { id: "cred-1", token: "aqk_member", userId: 2, projectId: "proj-a" })

      const page1Res = await handleExternalReadRequest(
        req("/api/v1/external/projects/proj-a/files/file-x/cells?limit=2", "aqk_member"),
        env(testDb),
      )
      const page1 = (await page1Res!.json()) as {
        data: Array<{ cellId: string }>
        nextCursor: string | null
      }
      expect(page1.data).toHaveLength(2)
      expect(page1.nextCursor).not.toBeNull()

      const page2Res = await handleExternalReadRequest(
        req(`/api/v1/external/projects/proj-a/files/file-x/cells?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`, "aqk_member"),
        env(testDb),
      )
      const page2 = (await page2Res!.json()) as {
        data: Array<{ cellId: string }>
        nextCursor: string | null
      }
      expect(page2.data.length).toBeGreaterThan(0)
      // No overlap between pages.
      const page1Ids = new Set(page1.data.map((c) => c.cellId))
      for (const c of page2.data) expect(page1Ids.has(c.cellId)).toBe(false)

      // Walk to the end; the final page's nextCursor must be null.
      let cursor = page2.nextCursor
      let guard = 0
      while (cursor !== null && guard < 10) {
        guard++
        const res = await handleExternalReadRequest(
          req(`/api/v1/external/projects/proj-a/files/file-x/cells?limit=2&cursor=${encodeURIComponent(cursor)}`, "aqk_member"),
          env(testDb),
        )
        const body = (await res!.json()) as { data: unknown[]; nextCursor: string | null }
        cursor = body.nextCursor
      }
      expect(cursor).toBeNull()
    })
  })
})
