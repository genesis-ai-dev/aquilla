// AQU-1180 — translator identity must not leak through the agent-facing API.
//
// The regression these guard is not "a field changed shape": it is that a PAT
// pasted into a third-party AI console used to hand that vendor the project's
// roster (GET /me → username, every cell → lastEditor, every history event →
// author). For teams translating in restricted regions that is a safety
// exposure, so the assertions below are deliberately written the way the issue
// specifies them — grep the WHOLE serialized payload for the human's handle,
// not just the field we remembered to scrub.

import { describe, it, expect, beforeEach } from "vitest"
import { handleExternalReadRequest } from "../external/read-routes"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"
const CRED_DEFAULT = "00000000-0000-0000-0000-0000000000a1"
const CRED_PII = "00000000-0000-0000-0000-0000000000a2"

/** The minting user's handle — the string that must never appear in a default
 *  token's responses. */
const HUMAN = "anastasiia"

async function seedCredential(
  testDb: TestDb,
  opts: { id: string; userId: number; projectId: string; pii?: boolean },
): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, project_id, pii)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, $6)`,
    [opts.id, String(opts.userId), tokenPrefix, tokenHash, opts.projectId, opts.pii === true],
  )
  return token
}

function env(testDb: TestDb) {
  return { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET }
}

function req(path: string, token: string): Request {
  return new Request(`https://worker${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

/** A project whose cells and events were all written by a real named human. */
async function seedProject(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, $1, 'a@x.com', 'h')`,
    [HUMAN],
  )
  await testDb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'Ukrainian BSB', 10, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-x', 'proj-a', 'Genesis', 'evt-file-1')`,
  )
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count, last_editor)
     VALUES ('proj-a', 'file-x', 'cell-1', 'source', 'In the beginning', 'evt-1', 1000, 3, 'importer')`,
  )
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count, last_editor)
     VALUES ('proj-a', 'file-x', 'cell-1', 'target', 'На початку', 'evt-2', 2000, 2, $1)`,
    [HUMAN],
  )
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count, last_editor)
     VALUES ('proj-a', 'file-x', 'cell-2', 'target', 'І сказав Бог', 'evt-3', 3000, 3, $1)`,
    [HUMAN],
  )
  await testDb.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES ('evt-1', 1, 'proj-a', 'file-x', 'cell-1', 'source.cell.create', 'importer', '{"value":"In the beginning"}', 100, 100, NULL, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
     VALUES ('evt-2', 1, 'proj-a', 'file-x', 'cell-1', 'target.cell.commit', $1, '{"value":"На початку"}', 200, 200, NULL, 2)`,
    [HUMAN],
  )
}

async function setAgentAuthorship(testDb: TestDb, value: string) {
  await testDb.pg.query(
    `INSERT INTO project_settings (project_id, settings) VALUES ('proj-a', $1)
     ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    [JSON.stringify({ agentAuthorship: value })],
  )
}

/** Fetch a read route and return both the parsed body and its raw JSON text —
 *  the raw text is what the "no handle anywhere in the payload" grep runs on. */
async function read(
  testDb: TestDb,
  path: string,
  token: string,
): Promise<{ status: number; body: { data: Array<Record<string, unknown>> }; raw: string }> {
  const res = await handleExternalReadRequest(req(path, token), env(testDb))
  expect(res).not.toBeNull()
  const raw = await res!.text()
  return { status: res!.status, body: JSON.parse(raw) as { data: Array<Record<string, unknown>> }, raw }
}

const CELLS_PATH = "/api/v1/external/projects/proj-a/files/file-x/cells"
const HISTORY_PATH = "/api/v1/external/projects/proj-a/cells/cell-1/history"
const ME_PATH = "/api/v1/external/me"

describe("AQU-1180 — agent-facing PII scrub", () => {
  let testDb: TestDb

  beforeEach(async () => {
    testDb = await makeTestDb()
    await seedProject(testDb)
  })

  describe("default credential (pii off)", () => {
    it("returns no username, name, or email anywhere in a cells payload", async () => {
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })
      const { status, raw, body } = await read(testDb, CELLS_PATH, token)
      expect(status).toBe(200)
      // The acceptance criterion, literally: grep the full response.
      expect(raw).not.toContain(HUMAN)
      expect(raw).not.toContain("a@x.com")
      // Still pseudonymously attributed, so an agent can group edits by person.
      const target = body.data.find((c) => c.side === "target" && c.cellId === "cell-1")
      expect(target?.lastEditor).toMatch(/^u_[0-9a-f]{8}$/)
    })

    it("gives the same person the same pseudonym across cells, and passes machine authors through", async () => {
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })
      const { body } = await read(testDb, CELLS_PATH, token)
      const targets = body.data.filter((c) => c.side === "target")
      expect(targets).toHaveLength(2)
      // Same human, two cells, one stable id — this is the whole point of
      // pseudonymising rather than dropping.
      expect(targets[0].lastEditor).toBe(targets[1].lastEditor)
      const source = body.data.find((c) => c.side === "source")
      expect(source?.lastEditor).toBe("importer")
    })

    it("scrubs the author on every history event", async () => {
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })
      const { status, raw, body } = await read(testDb, HISTORY_PATH, token)
      expect(status).toBe(200)
      expect(raw).not.toContain(HUMAN)
      const commit = body.data.find((e) => e.kind === "target.cell.commit")
      expect(commit?.author).toMatch(/^u_[0-9a-f]{8}$/)
      const create = body.data.find((e) => e.kind === "source.cell.create")
      expect(create?.author).toBe("importer")
    })

    it("GET /me answers which token, not which human", async () => {
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })
      const res = await handleExternalReadRequest(req(ME_PATH, token), env(testDb))
      const raw = await res!.text()
      expect(raw).not.toContain(HUMAN)
      const body = JSON.parse(raw) as Record<string, unknown>
      expect(body).not.toHaveProperty("username")
      expect(body).not.toHaveProperty("userId")
      // Scope and autonomy are the credential's own reach, not a person.
      expect(body.credentialId).toBe(CRED_DEFAULT)
      expect(body.mode).toBe("act")
      expect(body.projectId).toBe("proj-a")
    })

    it("mints different pseudonyms for the same human in different projects", async () => {
      await testDb.pg.query(
        `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-b', 'Other', 10, 1)`,
      )
      await testDb.pg.query(
        `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-y', 'proj-b', 'Exodus', 'evt-file-2')`,
      )
      await testDb.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count, last_editor)
         VALUES ('proj-b', 'file-y', 'cell-9', 'target', 'x', 'evt-9', 1000, 1, $1)`,
        [HUMAN],
      )
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })
      const tokenB = await seedCredential(testDb, { id: CRED_PII, userId: 1, projectId: "proj-b" })
      const a = await read(testDb, CELLS_PATH, token)
      const b = await read(testDb, "/api/v1/external/projects/proj-b/files/file-y/cells", tokenB)
      const idA = a.body.data.find((c) => c.side === "target")?.lastEditor
      const idB = b.body.data.find((c) => c.side === "target")?.lastEditor
      expect(idA).toMatch(/^u_[0-9a-f]{8}$/)
      expect(idB).toMatch(/^u_[0-9a-f]{8}$/)
      // Unlinkable across projects: two agents comparing notes must not be able
      // to re-identify a translator by intersecting their ids.
      expect(idA).not.toBe(idB)
    })
  })

  describe("pii credential (minted by an owner)", () => {
    it("returns real identities on cells, history, and /me", async () => {
      const token = await seedCredential(testDb, {
        id: CRED_PII,
        userId: 1,
        projectId: "proj-a",
        pii: true,
      })
      const cells = await read(testDb, CELLS_PATH, token)
      expect(cells.body.data.find((c) => c.side === "target")?.lastEditor).toBe(HUMAN)

      const history = await read(testDb, HISTORY_PATH, token)
      expect(history.body.data.find((e) => e.kind === "target.cell.commit")?.author).toBe(HUMAN)

      const res = await handleExternalReadRequest(req(ME_PATH, token), env(testDb))
      const me = (await res!.json()) as Record<string, unknown>
      expect(me.username).toBe(HUMAN)
      expect(me.userId).toBe("1")
    })
  })

  describe("project setting agentAuthorship: none", () => {
    it("drops author fields entirely — absent, not blanked", async () => {
      await setAgentAuthorship(testDb, "none")
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })

      const cells = await read(testDb, CELLS_PATH, token)
      for (const cell of cells.body.data) {
        // `"lastEditor": null` would still say "someone edited this and we are
        // hiding them". The key has to be gone.
        expect(cell).not.toHaveProperty("lastEditor")
      }

      const history = await read(testDb, HISTORY_PATH, token)
      expect(history.body.data.length).toBeGreaterThan(0)
      for (const event of history.body.data) {
        expect(event).not.toHaveProperty("author")
      }
    })

    it("overrides a pii credential — the project's opt-out wins", async () => {
      await setAgentAuthorship(testDb, "none")
      const token = await seedCredential(testDb, {
        id: CRED_PII,
        userId: 1,
        projectId: "proj-a",
        pii: true,
      })
      const cells = await read(testDb, CELLS_PATH, token)
      expect(cells.raw).not.toContain(HUMAN)
      for (const cell of cells.body.data) expect(cell).not.toHaveProperty("lastEditor")
    })

    it("any other setting value keeps the pseudonymous default", async () => {
      await setAgentAuthorship(testDb, "pseudonymous")
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })
      const cells = await read(testDb, CELLS_PATH, token)
      expect(cells.raw).not.toContain(HUMAN)
      expect(cells.body.data.find((c) => c.side === "target")?.lastEditor).toMatch(/^u_[0-9a-f]{8}$/)
    })
  })

  describe("audit trail", () => {
    it("traces credential → cells read", async () => {
      const token = await seedCredential(testDb, { id: CRED_DEFAULT, userId: 1, projectId: "proj-a" })
      await read(testDb, CELLS_PATH, token)
      await read(testDb, HISTORY_PATH, token)

      const rows = await testDb.rows<{
        credential_id: string
        project_id: string
        resource: string
        resource_id: string
        row_count: number
      }>("agent_read_audit")
      expect(rows).toHaveLength(2)

      const cellsRow = rows.find((r) => r.resource === "cells")
      expect(cellsRow).toMatchObject({
        credential_id: CRED_DEFAULT,
        project_id: "proj-a",
        resource_id: "file-x",
      })
      expect(cellsRow!.row_count).toBeGreaterThan(0)

      expect(rows.find((r) => r.resource === "history")).toMatchObject({
        credential_id: CRED_DEFAULT,
        project_id: "proj-a",
        resource_id: "cell-1",
      })
    })
  })
})
