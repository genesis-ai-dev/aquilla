// AQU-1232 — GET /api/v1/external/projects/:projectId/similar.
//
// Translation-memory retrieval for agents: "which source cells read like this
// one, and how were they rendered?". Driven through handleExternalReadRequest
// (not the handler directly) because that is the entry point the MCP tier's
// runRead delegation also uses — testing the module in isolation would not
// prove the route is actually reachable.
//
// Real Postgres (PGlite) so tsquery/ts_rank run for real; credentials are
// minted through the shared api_credentials module exactly as external-reads
// does.

import { describe, it, expect, beforeEach } from "vitest"
import { handleExternalReadRequest } from "../external/read-routes"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"
const CRED_1 = "00000000-0000-0000-0000-000000000001"

interface SimilarRow {
  cellId: string
  fileId: string
  sourceValue: string
  targetValue: string
  targetLang: string
  score: number
}

async function seedCredential(
  testDb: TestDb,
  opts: { id: string; userId: number; projectId?: string | null },
): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', NULL, $5)`,
    [opts.id, String(opts.userId), tokenPrefix, tokenHash, opts.projectId ?? null],
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

interface SeedCell {
  cellId: string
  source: string
  target: string
  fileId?: string
  targetLang?: string
}

// "the query": cell-q. Its near-duplicate (cell-near) shares almost every
// term; cell-super contains all of them plus a long tail; cell-far shares one
// stop-ish word; cell-none shares nothing.
const CELLS: SeedCell[] = [
  { cellId: "cell-q", source: "In the beginning God created the heavens", target: "Au commencement" },
  {
    cellId: "cell-near",
    source: "In the beginning God created the earth",
    target: "Au commencement Dieu créa la terre",
  },
  {
    cellId: "cell-super",
    source:
      "In the beginning God created the heavens and also every living creature that moves upon the waters below",
    target: "Au commencement Dieu créa toutes choses",
  },
  { cellId: "cell-far", source: "God is love", target: "Dieu est amour" },
  { cellId: "cell-none", source: "Peace be with you", target: "La paix soit avec vous" },
  // Untranslated: never returned — an empty rendering is not a precedent.
  { cellId: "cell-untranslated", source: "In the beginning God created light", target: "" },
]

async function seedProject(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'owner', 'o@x.com', 'h'), (2, 'member', 'm@x.com', 'h')`,
  )
  await testDb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`)
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'Project A', 10, 1), ('proj-b', 'Project B', 10, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-a', 2, 400)`,
  )
  await testDb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ('file-x', 'proj-a', 'Genesis', 'evt-file-1')`,
  )
  for (const c of CELLS) {
    for (const side of ["source", "target"] as const) {
      const value = side === "source" ? c.source : c.target
      await testDb.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, target_lang, event_id, last_edit_at, word_count)
         VALUES ('proj-a', $1, $2, $3, $4, $5, $6, 1000, $7)`,
        [
          c.fileId ?? "file-x",
          c.cellId,
          side,
          value,
          side === "target" ? (c.targetLang ?? "") : "",
          `ev-${c.cellId}-${side}`,
          value === "" ? 0 : value.split(/\s+/).length,
        ],
      )
    }
  }
}

async function similar(testDb: TestDb, query: string, token: string) {
  const res = await handleExternalReadRequest(
    req(`/api/v1/external/projects/proj-a/similar?${query}`, token),
    env(testDb),
  )
  expect(res).not.toBeNull()
  return res!
}

describe("external similarity search (AQU-1232)", () => {
  let testDb: TestDb
  let token: string

  beforeEach(async () => {
    testDb = await makeTestDb()
    await seedProject(testDb)
    token = await seedCredential(testDb, { id: CRED_1, userId: 2, projectId: "proj-a" })
  })

  it("ranks a near-duplicate above a merely overlapping line, by cellId", async () => {
    const res = await similar(testDb, "cellId=cell-q", token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: SimilarRow[]; nextCursor: string | null }

    const ids = body.data.map((r) => r.cellId)
    expect(ids[0]).toBe("cell-near")
    // The superset shares every one of the query's terms but drags a long tail
    // along — a coverage score would tie it with the near-duplicate at 1.0.
    // Jaccard must place it strictly lower.
    expect(ids).toContain("cell-super")
    const near = body.data.find((r) => r.cellId === "cell-near")!
    const superset = body.data.find((r) => r.cellId === "cell-super")!
    expect(near.score).toBeGreaterThan(superset.score)
    // Nothing in common → never retrieved at all.
    expect(ids).not.toContain("cell-none")
    // No target yet → not a usable precedent.
    expect(ids).not.toContain("cell-untranslated")
  })

  it("excludes the query cell from its own results", async () => {
    const res = await similar(testDb, "cellId=cell-q", token)
    const body = (await res.json()) as { data: SimilarRow[] }
    expect(body.data.map((r) => r.cellId)).not.toContain("cell-q")
  })

  it("returns each match with its current target and a score in [0,1]", async () => {
    const res = await similar(testDb, "cellId=cell-q", token)
    const body = (await res.json()) as { data: SimilarRow[] }
    const near = body.data.find((r) => r.cellId === "cell-near")!
    expect(near.fileId).toBe("file-x")
    expect(near.sourceValue).toBe("In the beginning God created the earth")
    expect(near.targetValue).toBe("Au commencement Dieu créa la terre")
    expect(near.targetLang).toBe("")
    expect(near.score).toBeGreaterThan(0)
    expect(near.score).toBeLessThanOrEqual(1)
  })

  it("works by free text as well as by cellId", async () => {
    const res = await similar(
      testDb,
      `text=${encodeURIComponent("In the beginning God created the earth")}`,
      token,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: SimilarRow[] }
    // An exact-text query matches its own cell at 1.0 — nothing to exclude here.
    expect(body.data[0].cellId).toBe("cell-near")
    expect(body.data[0].score).toBe(1)
  })

  it("never leaks author identities (PII default)", async () => {
    const res = await similar(testDb, "cellId=cell-q", token)
    const body = (await res.json()) as { data: Record<string, unknown>[] }
    expect(body.data.length).toBeGreaterThan(0)
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual([
        "cellId",
        "fileId",
        "score",
        "sourceValue",
        "targetLang",
        "targetValue",
      ])
    }
  })

  it("honours limit and paginates deterministically", async () => {
    const first = await similar(testDb, "cellId=cell-q&limit=1", token)
    const firstBody = (await first.json()) as { data: SimilarRow[]; nextCursor: string | null }
    expect(firstBody.data).toHaveLength(1)
    expect(firstBody.nextCursor).not.toBeNull()

    const second = await similar(
      testDb,
      `cellId=cell-q&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      token,
    )
    const secondBody = (await second.json()) as { data: SimilarRow[] }
    expect(secondBody.data).toHaveLength(1)
    expect(secondBody.data[0].cellId).not.toBe(firstBody.data[0].cellId)
  })

  it("a wrong-project PAT gets 403", async () => {
    const scoped = await seedCredential(testDb, {
      id: "00000000-0000-0000-0000-000000000002",
      userId: 2,
      projectId: "proj-b",
    })
    const res = await similar(testDb, "cellId=cell-q", scoped)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("scope_denied")
  })

  it("an unknown cellId is not_found", async () => {
    const res = await similar(testDb, "cellId=nope", token)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("not_found")
  })

  it("rejects neither-arg and both-args", async () => {
    const neither = await similar(testDb, "limit=5", token)
    expect(neither.status).toBe(400)
    const both = await similar(testDb, "cellId=cell-q&text=anything", token)
    expect(both.status).toBe(400)
    expect(((await both.json()) as { error: { code: string } }).error.code).toBe("validation_failed")
  })

  it("throttles a credential that floods the read tier", async () => {
    await testDb.pg.query(
      `INSERT INTO auth_rate_limit_events (kind, identifier, success)
       SELECT 'external_read', $1, 1 FROM generate_series(1, 300)`,
      [`credential:${CRED_1}`],
    )
    const res = await similar(testDb, "cellId=cell-q", token)
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited")
  })

  it("query text with no tokenizable terms returns an empty page, not an error", async () => {
    const res = await similar(testDb, `text=${encodeURIComponent("!!! ???")}`, token)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: SimilarRow[]; nextCursor: string | null }
    expect(body.data).toEqual([])
    expect(body.nextCursor).toBeNull()
  })
})
