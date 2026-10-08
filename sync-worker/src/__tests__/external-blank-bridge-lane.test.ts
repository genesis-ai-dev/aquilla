// The blank bridge (legacy_tag '') is a real target lane. Passing its id must
// return that lane, not every target lane, and quality must report the id.

import { describe, it, expect, beforeEach } from "vitest"
import { sign } from "hono/jwt"
import { handleExternalReadRequest } from "../external/read-routes"
import { handleExternalQualityRequest } from "../external/quality-routes"
import { handleHealthRollupRequest } from "../events/health-rollup-route"
import { mintApiToken } from "../../../db/shared/api-credentials"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "test-secret"
const CRED = "00000000-0000-0000-0000-0000000000c1"
const BLANK = "bridge01"
const SW = "swlane01"

async function seed(testDb: TestDb): Promise<string> {
  await testDb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'owner', 'owner@x.com', 'h'), (2, 'member', 'member@x.com', 'h')`,
  )
  await testDb.pg.query(`INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Org A', 1)`)
  await testDb.pg.query(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-blank', 'Blank bridge', 10, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ('proj-blank', 2, 400)`,
  )
  await testDb.pg.query(
    `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count)
     VALUES ('file-x', 'proj-blank', 'John', 'evt-fx', 2, 2, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO lanes (id, project_id, role, legacy_tag, position) VALUES
       ($1, 'proj-blank', 'target', '', 1),
       ($2, 'proj-blank', 'target', 'sw', 2)`,
    [BLANK, SW],
  )
  await testDb.pg.query(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES
       ('proj-blank', 2, $1, 400),
       ('proj-blank', 2, $2, 400)`,
    [BLANK, SW],
  )
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, word_count)
     VALUES ('proj-blank', 'file-x', 'blank1', 'source', 'hello', 'evt-s-blank', 1000, 1),
            ('proj-blank', 'file-x', 'sw1', 'source', 'world', 'evt-s-sw', 1000, 1)`,
  )
  await testDb.pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at, word_count, validated)
     VALUES ('proj-blank', 'file-x', 'blank1', 'target', '', 'blank-line', 'evt-t-blank', 2000, 1, 1),
            ('proj-blank', 'file-x', 'sw1', 'target', 'sw', 'sw-line', 'evt-t-sw', 2000, 1, 0)`,
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await testDb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, '2', 'test', $2, $3, 'act', '10', 'proj-blank')`,
    [CRED, tokenPrefix, tokenHash],
  )
  return token
}

function req(path: string, token: string): Request {
  return new Request(`https://worker${path}`, { headers: { Authorization: `Bearer ${token}` } })
}

describe("blank bridge lane id (AQU-1615)", () => {
  let testDb: TestDb
  let token: string

  beforeEach(async () => {
    testDb = await makeTestDb()
    token = await seed(testDb)
  })

  it("cells for the blank lane's id omit the other target lane and keep the blank lane", async () => {
    const res = await handleExternalReadRequest(
      req(`/api/v1/external/projects/proj-blank/files/file-x/cells?lane=${BLANK}`, token),
      { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as {
      data: Array<{ side: string; value: string; laneId: string | null }>
    }
    const targets = body.data.filter((cell) => cell.side === "target")
    expect(targets.map((cell) => cell.value)).toEqual(["blank-line"])
    expect(targets[0]?.laneId).toBe(BLANK)
    expect(body.data.some((cell) => cell.value === "sw-line")).toBe(false)
    expect(body.data.some((cell) => cell.side === "source")).toBe(true)
  })

  it("quality health returns that lane id and scores only the blank bridge", async () => {
    const wallOff = await handleExternalQualityRequest(
      req(`/api/v1/external/projects/proj-blank/quality?lane=${BLANK}`, token),
      { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET },
    )
    expect(wallOff?.status).toBe(200)
    const offBody = (await wallOff!.json()) as {
      laneId?: string
      lane?: string
      projectHealth: number
      healthCellCount: number
    }
    expect(offBody.laneId).toBe(BLANK)
    expect(offBody.lane).toBeUndefined()
    expect(offBody.healthCellCount).toBe(1)
    expect(offBody.projectHealth).toBe(100)

    const walled = { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET, LANE_READ_WALL: "1" }
    const wallOn = await handleExternalQualityRequest(
      req(`/api/v1/external/projects/proj-blank/quality?lane=${BLANK}`, token),
      walled,
    )
    expect(wallOn?.status).toBe(200)
    const onBody = (await wallOn!.json()) as {
      laneId: string
      projectHealth: number
      healthCellCount: number
    }
    expect(onBody.laneId).toBe(BLANK)
    expect(onBody.healthCellCount).toBe(1)
    expect(onBody.projectHealth).toBe(100)

    const mixed = await internalHealth(testDb, "")
    expect(mixed.totalCells).toBe(2)
    expect(onBody.projectHealth).not.toBe(mixed.projectHealth)
  })
})

async function internalHealth(
  testDb: TestDb,
  search: string,
): Promise<{ projectHealth: number; totalCells: number }> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = await sign(
    {
      userId: 2,
      projectId: "proj-blank",
      fileId: "file-x",
      role: 400,
      aud: "sync",
      iat: now,
      exp: now + 300,
      laneGrants: [
        { lane: BLANK, level: 400 },
        { lane: SW, level: 400 },
      ],
    },
    SECRET,
    "HS256",
  )
  const res = await handleHealthRollupRequest(
    new Request(`https://worker/api/v1/projects/proj-blank/health-rollup${search}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    }),
    { AQUILLA_PG: testDb.db, SYNC_SECRET_KEY: SECRET, LANE_READ_WALL: "1" },
  )
  expect(res?.status).toBe(200)
  return (await res!.json()) as { projectHealth: number; totalCells: number }
}
