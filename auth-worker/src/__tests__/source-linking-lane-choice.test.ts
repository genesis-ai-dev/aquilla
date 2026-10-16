// AQU-1605: POST /:projectId/link-source — WHICH of the upstream's lanes the
// link consumes.
//
// Before this slice a `consumes: 'target'` link always read the upstream's
// former default lane (sync-worker link-sync.ts, AQU-538), so an upstream that
// translates into several languages could only be chained from on whichever lane
// carried the empty legacy tag. The request now names the lane by `lanes.id`, and
// the server is what decides the choice is legitimate: the picker it came from
// lists only lanes the caller may see, and a request that did not come from that
// picker must not reach further.
//
// Pinned here:
//   1. A named lane is stored and echoed. Omitting it stores a concrete id:
//      the one target lane the caller can see, or a 400 when that is not
//      exactly one. NULL remains the pre-slice shape of rows AQU-1616 has
//      not backfilled; this writer does not produce it.
//   2. A lane that is not one of THIS upstream's target lanes is refused —
//      including a real lane of another project (lane ids are globally unique
//      since AQU-1606, so one resolves) and the upstream's own source lane.
//   3. An archived lane is refused: it is frozen, so the link could only ever
//      mirror a corpus nobody may still edit.
//   4. The lane read wall applies. A link is a read — it copies the lane's text
//      into a project the caller controls — so a member granted one lane of the
//      upstream cannot link to another.
//   5. Detach clears the lane with the rest of the link metadata.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const DOWN = "proj-1605-down"
const UP = "proj-1605-up"
const OTHER = "proj-1605-other"

const LANE_DEFAULT = "lane-1605-default"
const LANE_FRENCH = "lane-1605-french"
const LANE_ARCHIVED = "lane-1605-archived"
const LANE_SOURCE = "lane-1605-source"
const LANE_ELSEWHERE = "lane-1605-elsewhere"

async function seedProject(projectId: string, name: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, name, createdBy)
    .run()
}

async function addMember(projectId: string, userId: number, roleLevel: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
  )
    .bind(projectId, userId, roleLevel)
    .run()
}

async function seedLane(
  id: string,
  projectId: string,
  role: "source" | "target",
  name: string,
  legacyTag: string | null,
  position: number,
  archived = false,
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, projectId, role, name, legacyTag, position, archived ? new Date().toISOString() : null)
    .run()
}

async function grantLane(projectId: string, userId: number, laneId: string, level = 100): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level, granted_by)
     VALUES (?, ?, ?, ?, 1)`,
  )
    .bind(projectId, userId, laneId, level)
    .run()
}

async function link(
  body: Record<string, unknown>,
  as = "lead",
): Promise<Response> {
  return app.request(
    `/api/v2/projects/${DOWN}/link-source`,
    { method: "POST", headers: authHeader(await jwtFor(as)), body: JSON.stringify(body) },
    env,
  )
}

async function storedLaneId(): Promise<string | null> {
  const row = await env.AQUILLA_PG.prepare("SELECT source_link_lane_id FROM projects WHERE id = ?")
    .bind(DOWN)
    .first<{ source_link_lane_id: string | null }>()
  return row?.source_link_lane_id ?? null
}

beforeEach(async () => {
  vi.restoreAllMocks()
  // The link route seeds a live link through the sync-worker; the seed itself is
  // not what these tests are about.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ranSync: true }), { status: 200 }),
  )
  await seedUser(1, "lead")
  await seedUser(2, "scoped")
  await seedUser(3, "upstream-owner")
  await seedProject(DOWN, "Chaluba", 1)
  await seedProject(UP, "French NT", 3)
  await seedProject(OTHER, "Spanish NT", 3)
  await addMember(DOWN, 1, 500)
  await addMember(UP, 1, 100)
  await addMember(DOWN, 2, 500)
  await addMember(UP, 2, 100)
  await seedLane(LANE_SOURCE, UP, "source", "Greek", null, 0)
  await seedLane(LANE_DEFAULT, UP, "target", "French", "", 1)
  await seedLane(LANE_FRENCH, UP, "target", "Quebec French", "Quebec French", 2)
  await seedLane(LANE_ARCHIVED, UP, "target", "Old French", "Old French", 3, true)
  await seedLane(LANE_ELSEWHERE, OTHER, "target", "Spanish", "Spanish", 0)
})

afterEach(() => {
  env.LANE_READ_WALL = undefined
})

describe("POST /:projectId/link-source — the upstream lane (AQU-1605)", () => {
  // WHY: the slice's happy path — the chain case names one of the upstream's
  // translations, and that is what the mirror will fold.
  it("stores and echoes the chosen lane", async () => {
    const res = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_FRENCH,
    })
    expect(res.status).toBe(200)
    expect((await res.json<{ laneId: string | null }>()).laneId).toBe(LANE_FRENCH)
    expect(await storedLaneId()).toBe(LANE_FRENCH)
  })

  // WHY: omitting the lane used to store NULL before any visibility check, and
  // NULL means the former default lane. A caller who can see more than one
  // target lane has not chosen, so the link is refused rather than guessed.
  it("omitting the lane when several target lanes are visible is a 400", async () => {
    const res = await link({ sourceProjectId: UP, mode: "live", consumes: "target" })
    expect(res.status).toBe(400)
    expect(await storedLaneId()).toBeNull()
  })

  // WHY: the same omission, for a member granted only French. NULL would have
  // linked the default lane, which this member cannot see. Exactly one visible
  // non-archived target lane is stored instead.
  it("a walled member granted only French, omitting laneId, does not link the default lane", async () => {
    env.LANE_READ_WALL = "1"
    await grantLane(UP, 2, LANE_FRENCH)

    const res = await link({ sourceProjectId: UP, mode: "live", consumes: "target" }, "scoped")
    expect(res.status).toBe(200)
    expect((await res.json<{ laneId: string }>()).laneId).toBe(LANE_FRENCH)
    expect(await storedLaneId()).toBe(LANE_FRENCH)
  })

  it("a source link that omits laneId stores the upstream source lane", async () => {
    const res = await link({ sourceProjectId: UP, mode: "live", consumes: "source" })
    expect(res.status).toBe(200)
    expect(await storedLaneId()).toBe(LANE_SOURCE)
  })

  // WHY: re-posting link-source is how Source & sync settings changes the
  // lane. The downstream source already holds the old lane's text, and this
  // route does not rewrite it.
  it("refuses to change the lane of a live link until it is detached", async () => {
    const first = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_FRENCH,
    })
    expect(first.status).toBe(200)

    const changed = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_DEFAULT,
    })
    expect(changed.status).toBe(409)
    expect(await storedLaneId()).toBe(LANE_FRENCH)

    const same = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_FRENCH,
    })
    expect(same.status).toBe(200)
    expect(await storedLaneId()).toBe(LANE_FRENCH)

    const detached = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )
    expect(detached.status).toBe(200)
    const after = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_DEFAULT,
    })
    expect(after.status).toBe(200)
    expect(await storedLaneId()).toBe(LANE_DEFAULT)
  })

  // WHY: lane ids are globally unique (AQU-1606), so a lane id from another
  // project resolves to a real row. Storing it would point the fold at a lane
  // this upstream has never had.
  it("refuses a lane that belongs to another project", async () => {
    const res = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_ELSEWHERE,
    })
    expect(res.status).toBe(400)
    expect(await storedLaneId()).toBeNull()
  })

  it("refuses the upstream's SOURCE lane for a target-consumption link", async () => {
    const res = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_SOURCE,
    })
    expect(res.status).toBe(400)
    expect(await storedLaneId()).toBeNull()
  })

  // WHY: an archived lane is frozen (AQU-1462), so the link would look live and
  // never move.
  it("refuses an archived lane", async () => {
    const res = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "target",
      laneId: LANE_ARCHIVED,
    })
    expect(res.status).toBe(400)
    expect(await storedLaneId()).toBeNull()
  })

  // WHY: the picker only ever offers lanes the caller may see; the server is
  // what makes that a rule rather than a courtesy. Without it, one lane's
  // contributor could mirror every other lane's translations out of the upstream.
  it("refuses a lane the caller's grants do not include, and allows one they do", async () => {
    env.LANE_READ_WALL = "1"
    await grantLane(UP, 2, LANE_DEFAULT)

    const refused = await link(
      { sourceProjectId: UP, mode: "live", consumes: "target", laneId: LANE_FRENCH },
      "scoped",
    )
    expect(refused.status).toBe(403)
    expect(await storedLaneId()).toBeNull()

    const allowed = await link(
      { sourceProjectId: UP, mode: "live", consumes: "target", laneId: LANE_DEFAULT },
      "scoped",
    )
    expect(allowed.status).toBe(200)
    expect(await storedLaneId()).toBe(LANE_DEFAULT)
  })

  // WHY: a `consumes: 'source'` link reads the upstream's source lane, which is
  // not lane-scoped in the projection — the column records it, and the read wall
  // (which only ever restricts target lanes) has nothing to say about it.
  it("accepts the upstream's source lane for a source-consumption link", async () => {
    const res = await link({
      sourceProjectId: UP,
      mode: "live",
      consumes: "source",
      laneId: LANE_SOURCE,
    })
    expect(res.status).toBe(200)
    expect(await storedLaneId()).toBe(LANE_SOURCE)
  })

  it("detach clears the lane with the rest of the link metadata", async () => {
    await link({ sourceProjectId: UP, mode: "live", consumes: "target", laneId: LANE_FRENCH })
    expect(await storedLaneId()).toBe(LANE_FRENCH)

    const res = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await storedLaneId()).toBeNull()
  })
})

describe("GET /:projectId/settings — lanes a walled member may link (AQU-1605)", () => {
  // WHY: the link wizard reads this response (loadUpstreamLaneChoices) and
  // offers every target lane it contains. The wizard tests mock that loader;
  // this is the server answer they are mocking.
  it("returns only the target lanes the member was granted", async () => {
    env.LANE_READ_WALL = "1"
    await grantLane(UP, 2, LANE_FRENCH)

    const res = await app.request(
      `/api/v2/projects/${UP}/settings`,
      { headers: authHeader(await jwtFor("scoped")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ lanes: { id: string; role: string }[] }>()
    expect(body.lanes.filter((lane) => lane.role === "target").map((lane) => lane.id)).toEqual([
      LANE_FRENCH,
    ])
  })
})
