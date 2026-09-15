// AQU-1231 — Agent API quality reads: per-file health, coverage, and the
// term-consistency drift list.
//
// The point of these tests is PARITY, not "the route returns a number". The
// health and coverage cases assert the external response equals what the
// INTERNAL routes the UI reads return for the same project (called directly,
// with a real sync-token, against the same PGlite database) — so a future
// change to health scoring or to the progress projection's denominators
// (AQU-1083's headings/paratextual exclusion, when it lands) can never move
// the UI's numbers without moving the API's.
//
// The term case asserts the drift shape against a seeded termbase, exercising
// the SHARED scan imported from src/lib/check/term-consistency-scan.ts — the
// same function the in-app "Check file" pass calls (rule 12: a real producer's
// output — the `cells` + `concepts` projections — through its real consumer).

import { describe, it, expect, beforeEach } from "vitest"
import { sign } from "hono/jwt"
import { handleExternalQualityRequest } from "../external/quality-routes"
import { handleHealthRollupRequest } from "../events/health-rollup-route"
import { handleProgressReadRequest } from "../events/progress-read-route"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"
const CRED_A = "00000000-0000-0000-0000-0000000000a1"
const CRED_B = "00000000-0000-0000-0000-0000000000b1"

/** Mint a real `aqk_` credential row and return the plaintext bearer token. */
async function seedCredential(
  testDb: TestDb,
  opts: { id: string; userId: number; orgId?: number | null; projectId?: string | null },
): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, $6)`,
    [
      opts.id,
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

/** An in-app sync-token, so the internal routes can be called for the parity
 *  comparison exactly as the SPA calls them. */
async function internalReq(path: string, projectId: string, fileId = ""): Promise<Request> {
  const now = Math.floor(Date.now() / 1000)
  const token = await sign(
    { userId: 2, projectId, fileId, role: 400, aud: "sync", iat: now, exp: now + 300 },
    SECRET,
    "HS256",
  )
  return new Request(`https://worker${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

/**
 * One project with two files:
 *   file-x — 4 source cells, 3 translated, 1 validated; a progress projection
 *            row so the read takes the `projection` path.
 *   file-y — 1 source cell, untranslated, NO projection row so the read falls
 *            back to the `files` counters.
 * Termbase: "grace" → preferred "gracia" (admitted "favor"); one cell renders
 * it as "merced" (drift). "spirit" is a DRAFT concept and must be ignored.
 */
async function seedProject(testDb: TestDb) {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'owner', 'owner@x.com', 'h'), (2, 'member', 'member@x.com', 'h')`,
  )
  await testDb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`)
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'Project A', 10, 1), ('proj-b', 'Project B', 11, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-a', 2, 400), ('proj-b', 2, 400)`,
  )
  await testDb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count)
     VALUES ('file-x', 'proj-a', 'Titus', 'evt-fx', 4, 3, 1), ('file-y', 'proj-a', 'Philemon', 'evt-fy', 1, 0, 0)`,
  )

  // file-x source cells + their targets.
  const cells: [string, string, string, string, number][] = [
    // cellId, canonicalRef, source, target, validated
    ["c1", "TIT 1:1", "the grace of God", "la gracia de Dios", 1],
    ["c2", "TIT 1:2", "grace and peace", "merced y paz", 0],
    ["c3", "TIT 1:3", "grace abounds", "favor abunda", 0],
    ["c4", "TIT 1:4", "grace to you", "", 0],
  ]
  for (const [cellId, ref, source, target, validated] of cells) {
    await testDb.pg.query(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at, word_count)
       VALUES ('proj-a', 'file-x', $1, 'source', $2, $3, $4, 1000, 3)`,
      [cellId, source, ref, `evt-s-${cellId}`],
    )
    if (target !== "") {
      await testDb.pg.query(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count, validated, endorsement_count)
         VALUES ('proj-a', 'file-x', $1, 'target', $2, $3, 2000, 3, $4, $5)`,
        [cellId, target, `evt-t-${cellId}`, validated, validated],
      )
    }
  }
  // file-y: one untranslated source cell, no projection row.
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
     VALUES ('proj-a', 'file-y', 'd1', 'source', 'grace be with you', 'evt-s-d1', 1000, 4)`,
  )

  // file-x's progress projection row: 4 cells, 3 filled, 1 endorsed once.
  await testDb.pg.query(
    `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, total_count, filled_count, validator_histogram, revision, updated_at)
     VALUES ('proj-a', 'file-x', 'file', '', 4, 3, '{"1":1}'::jsonb, 7, 1000)`,
  )

  await testDb.pg.query(
    `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status, created_at, updated_at)
     VALUES ($1, 'proj-a', 'grace', $2::jsonb, 'active', 1000, 1000),
            ($3, 'proj-a', 'spirit', $4::jsonb, 'draft', 1000, 1000)`,
    [
      "concept-grace",
      JSON.stringify([
        { rendering: "gracia", status: "preferred" },
        { rendering: "favor", status: "admitted" },
      ]),
      "concept-spirit",
      JSON.stringify([{ rendering: "espiritu", status: "preferred" }]),
    ],
  )
}

interface QualityBody {
  projectId: string
  projectHealth: number
  healthCellCount: number
  coverage: {
    totalCells: number
    filledCells: number
    validatedCells: number
    filledPercent: number
    validatedPercent: number
  }
  fileCount: number
  data: {
    fileId: string
    name: string
    health: number | null
    coverage: { totalCells: number; filledCells: number; validatedCells: number; filledPercent: number }
    validationCount: number
    coverageSource?: string
  }[]
  nextCursor: string | null
}

interface TermsBody {
  projectId: string
  fileId: string | null
  scannedCells: number
  conceptCount: number
  flaggedCellCount: number
  data: {
    conceptId: string
    sourceTerm: string
    approvedRenderings: string[]
    totalOccurrences: number
    consistentCount: number
    consistencyPercent: number
    renderingUsage: { rendering: string; cellIds: string[] }[]
    flaggedCells: { cellId: string; cellLabel?: string }[]
  }[]
}

describe("external quality reads (AQU-1231)", () => {
  let testDb: TestDb
  let tokenA: string
  let tokenB: string

  beforeEach(async () => {
    testDb = await makeTestDb()
    await seedProject(testDb)
    tokenA = await seedCredential(testDb, { id: CRED_A, userId: 2, orgId: 10, projectId: "proj-a" })
    tokenB = await seedCredential(testDb, { id: CRED_B, userId: 2, orgId: 11, projectId: "proj-b" })
  })

  // -- auth / scope ---------------------------------------------------------

  it("401s without a credential", async () => {
    const res = await handleExternalQualityRequest(req("/api/v1/external/projects/proj-a/quality"), env(testDb))
    expect(res?.status).toBe(401)
  })

  it("403 scope_denied when the credential is scoped to another project", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/quality", tokenB),
      env(testDb),
    )
    expect(res?.status).toBe(403)
    const body = (await res!.json()) as { error: { code: string } }
    expect(body.error.code).toBe("scope_denied")
  })

  it("403 scope_denied on the term-consistency read for a wrong-project credential", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/terms/consistency", tokenB),
      env(testDb),
    )
    expect(res?.status).toBe(403)
    const body = (await res!.json()) as { error: { code: string } }
    expect(body.error.code).toBe("scope_denied")
  })

  it("404s an unknown fileId rather than silently reporting the whole project", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/quality?fileId=nope", tokenA),
      env(testDb),
    )
    expect(res?.status).toBe(404)
  })

  it("returns null for a non-quality path so the router falls through", async () => {
    const res = await handleExternalQualityRequest(req("/api/v1/external/projects/proj-a/files", tokenA), env(testDb))
    expect(res).toBeNull()
  })

  // -- health parity --------------------------------------------------------

  it("per-file health equals the internal health-rollup route's value", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/quality", tokenA),
      env(testDb),
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as QualityBody

    const internal = await handleHealthRollupRequest(
      await internalReq("/api/v1/projects/proj-a/health-rollup", "proj-a"),
      env(testDb),
    )
    expect(internal?.status).toBe(200)
    const rollup = (await internal!.json()) as {
      projectHealth: number
      fileHealth: Record<string, number>
      totalCells: number
    }

    expect(body.projectHealth).toBe(rollup.projectHealth)
    expect(body.healthCellCount).toBe(rollup.totalCells)
    for (const file of body.data) {
      expect(file.health).toBe(rollup.fileHealth[file.fileId] ?? null)
    }
  })

  it("scoping to one file matches that file's own rollup", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/quality?fileId=file-x", tokenA),
      env(testDb),
    )
    const body = (await res!.json()) as QualityBody
    expect(body.fileCount).toBe(1)
    expect(body.data[0].fileId).toBe("file-x")

    const internal = await handleHealthRollupRequest(
      await internalReq("/api/v1/projects/proj-a/health-rollup?fileId=file-x", "proj-a", "file-x"),
      env(testDb),
    )
    const rollup = (await internal!.json()) as { fileHealth: Record<string, number> }
    expect(body.data[0].health).toBe(rollup.fileHealth["file-x"])
  })

  // -- coverage parity -----------------------------------------------------

  it("coverage counts and percentages equal the internal progress route's", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/quality?fileId=file-x", tokenA),
      env(testDb),
    )
    const body = (await res!.json()) as QualityBody
    const file = body.data[0]

    const internal = await handleProgressReadRequest(
      await internalReq("/api/v1/projects/proj-a/files/file-x/progress", "proj-a", "file-x"),
      env(testDb),
    )
    expect(internal?.status).toBe(200)
    const progress = (await internal!.json()) as {
      file: { totalCount: number; filledCount: number; validatedCount: number }
      validationCount: number
      source: string
    }

    expect(file.coverage.totalCells).toBe(progress.file.totalCount)
    expect(file.coverage.filledCells).toBe(progress.file.filledCount)
    expect(file.coverage.validatedCells).toBe(progress.file.validatedCount)
    expect(file.validationCount).toBe(progress.validationCount)
    expect(file.coverageSource).toBe(progress.source)
    // Same denominator the UI divides by — 3 of 4 filled, 1 of 4 validated.
    expect(file.coverage.filledPercent).toBe(75)
    expect(file.coverage.totalCells).toBe(4)
  })

  it("a file with no projection row still reports coverage from the files counters", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/quality?fileId=file-y", tokenA),
      env(testDb),
    )
    const body = (await res!.json()) as QualityBody
    expect(body.data[0].coverageSource).toBe("file-counter-fallback")
    expect(body.data[0].coverage.totalCells).toBe(1)
    expect(body.data[0].coverage.filledCells).toBe(0)
    expect(body.data[0].coverage.filledPercent).toBe(0)
  })

  it("project coverage sums the files in scope", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/quality", tokenA),
      env(testDb),
    )
    const body = (await res!.json()) as QualityBody
    expect(body.fileCount).toBe(2)
    // file-x (4 cells, 3 filled, 1 validated) + file-y (1 cell, 0 filled).
    expect(body.coverage.totalCells).toBe(5)
    expect(body.coverage.filledCells).toBe(3)
    expect(body.coverage.validatedCells).toBe(1)
    expect(body.coverage.filledPercent).toBe(60)
    expect(body.coverage.validatedPercent).toBe(20)
  })

  // -- term consistency ----------------------------------------------------

  it("lists the drifting term with the cells where each variant occurs", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/terms/consistency?fileId=file-x", tokenA),
      env(testDb),
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as TermsBody

    expect(body.fileId).toBe("file-x")
    expect(body.scannedCells).toBe(4)
    // Only the ACTIVE concept is scanned — the draft "spirit" is excluded.
    expect(body.conceptCount).toBe(1)
    expect(body.data).toHaveLength(1)

    const grace = body.data[0]
    expect(grace.conceptId).toBe("concept-grace")
    expect(grace.sourceTerm).toBe("grace")
    expect(grace.approvedRenderings).toEqual(["gracia", "favor"])
    // c4 has no target, so it is "not translated yet", not an inconsistency.
    expect(grace.totalOccurrences).toBe(3)
    expect(grace.consistentCount).toBe(2)
    expect(grace.consistencyPercent).toBe(67)
    // Where each approved variant occurs.
    expect(grace.renderingUsage).toEqual([
      { rendering: "gracia", cellIds: ["c1"] },
      { rendering: "favor", cellIds: ["c3"] },
    ])
    // And the drift: "merced" is none of the approved renderings.
    expect(grace.flaggedCells).toEqual([{ cellId: "c2", cellLabel: "TIT 1:2" }])
    expect(body.flaggedCellCount).toBe(1)
  })

  it("onlyDrift=1 drops fully-consistent concepts", async () => {
    // Make c2 consistent; the concept then has no flagged cells at all.
    await testDb.pg.query(
      `UPDATE cells SET value = 'gracia y paz' WHERE project_id = 'proj-a' AND file_id = 'file-x' AND cell_id = 'c2' AND side = 'target'`,
    )
    const all = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/terms/consistency?fileId=file-x", tokenA),
      env(testDb),
    )
    expect(((await all!.json()) as TermsBody).data).toHaveLength(1)

    const drift = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/terms/consistency?fileId=file-x&onlyDrift=1", tokenA),
      env(testDb),
    )
    const body = (await drift!.json()) as TermsBody
    expect(body.data).toEqual([])
    expect(body.flaggedCellCount).toBe(0)
  })

  it("scans the whole project when no fileId is given", async () => {
    const res = await handleExternalQualityRequest(
      req("/api/v1/external/projects/proj-a/terms/consistency", tokenA),
      env(testDb),
    )
    const body = (await res!.json()) as TermsBody
    expect(body.fileId).toBeNull()
    // 4 cells in file-x + 1 in file-y.
    expect(body.scannedCells).toBe(5)
    // file-y's cell is untranslated, so occurrences are unchanged.
    expect(body.data[0].totalOccurrences).toBe(3)
  })
})
