// AQU-1610: contextual reads, scene-brief propose, and copilot honour the same
// lane read wall as the sync worker. A member granted one lane is refused the
// other; an unknown id or the source lane is not a target lane.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "proj-lane-wall"
const FILE = "file-lane-wall"
const SOURCE = "src00001"
const GRANTED = "aaaa1111"
const HIDDEN = "bbbb2222"

function walledEnv(extra?: Record<string, unknown>) {
  return Object.assign(Object.create(env), { LANE_READ_WALL: "1" }, extra)
}

async function seedWorld(): Promise<string> {
  // The creator resolves as owner (700), which the wall treats as unrestricted.
  // The member under test is only a contributor.
  await seedUser(1, "owner")
  await seedUser(2, "walled")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'Walled', 1)")
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 2, 400, 2)",
  )
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES (?, ?, 'Mark', 'ev-file')",
  )
    .bind(FILE, PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES
       (?, ?, 'source', 'Source', NULL, 0),
       (?, ?, 'target', 'French', 'fr', 1),
       (?, ?, 'target', 'German', 'de', 2)`,
  )
    .bind(SOURCE, PROJECT, GRANTED, PROJECT, HIDDEN, PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES (?, 2, ?, 400)",
  )
    .bind(PROJECT, GRANTED)
    .run()
  return jwtFor("walled")
}

function contextual(path: string, jwt: string) {
  return app.request(
    `/api/v2/projects/${PROJECT}/contextual${path}`,
    { method: "GET", headers: authHeader(jwt) },
    walledEnv(),
  )
}

describe("lane read wall on contextual, scene briefs, and copilot", () => {
  it("refuses a walled member the lane they were not granted", async () => {
    const jwt = await seedWorld()

    expect((await contextual(`/overview?laneId=${HIDDEN}`, jwt)).status).toBe(403)
    expect((await contextual(`/runs?fileId=${FILE}&laneId=${HIDDEN}`, jwt)).status).toBe(403)
    expect((await contextual(`/drafts?fileId=${FILE}&laneId=${HIDDEN}`, jwt)).status).toBe(403)

    const brief = await app.request(
      `/api/v2/projects/${PROJECT}/scene-briefs`,
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({
          fileId: FILE,
          startCellId: "c1",
          endCellId: "c2",
          laneId: HIDDEN,
          construal: "A reading of the hidden lane.",
        }),
      },
      walledEnv(),
    )
    expect(brief.status).toBe(403)

    const agent = await app.request(
      "/api/v1/ai/agent/run",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({
          projectId: PROJECT,
          messages: [{ role: "user", content: "draft the next verse" }],
          context: { lane: HIDDEN },
        }),
      },
      walledEnv({ OPENROUTER_API_KEY: "test-key" }),
    )
    expect(agent.status).toBe(403)
  })

  it("rejects an unknown id and the source lane, and serves the granted lane", async () => {
    const jwt = await seedWorld()

    expect((await contextual("/overview?laneId=deadbeef", jwt)).status).toBe(400)
    expect((await contextual(`/overview?laneId=${SOURCE}`, jwt)).status).toBe(400)
    expect((await contextual(`/overview?laneId=${GRANTED}`, jwt)).status).toBe(200)

    const unknown = await app.request(
      `/api/v2/projects/${PROJECT}/scene-briefs`,
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({
          fileId: FILE,
          startCellId: "c1",
          endCellId: "c2",
          laneId: "deadbeef",
          construal: "Nope.",
        }),
      },
      walledEnv(),
    )
    expect(unknown.status).toBe(400)

    const source = await app.request(
      `/api/v2/projects/${PROJECT}/scene-briefs`,
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({
          fileId: FILE,
          startCellId: "c1",
          endCellId: "c2",
          laneId: SOURCE,
          construal: "Nope.",
        }),
      },
      walledEnv(),
    )
    expect(source.status).toBe(400)

    const granted = await app.request(
      `/api/v2/projects/${PROJECT}/scene-briefs`,
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({
          fileId: FILE,
          startCellId: "c1",
          endCellId: "c2",
          laneId: GRANTED,
          construal: "A reading of the granted lane.",
        }),
      },
      walledEnv(),
    )
    expect(granted.status).toBe(201)
  })
})
