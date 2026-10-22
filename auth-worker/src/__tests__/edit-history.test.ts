// Decision 11: a person's undo history for a project, kept on the server so it
// follows them between devices (routes/edit-history.ts, migration 0187). The
// revision is the guarantee two devices writing at once cannot lose each
// other's steps, and the session is the guarantee nobody reads another's.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "proj-history"

async function seedProject(projectId: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, "History Project", createdBy)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

const doc = (labels: string[]) => ({
  undo: labels.map((labelKey, i) => ({ id: `s${i}`, kind: "take.rename", data: {}, labelKey, at: i })),
  redo: [],
  log: [],
  gone: [],
})

async function req(method: string, path: string, jwt: string, body?: unknown, headers?: Record<string, string>) {
  return app.request(
    `/api/v2/projects/${PROJECT}/edit-history${path}`,
    { method, headers: { ...authHeader(jwt), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  )
}

async function setup(): Promise<{ asha: string; juma: string; outsider: string }> {
  await seedUser(1, "asha")
  await seedUser(2, "juma")
  await seedUser(3, "outsider")
  await seedProject(PROJECT, 1)
  await grant(PROJECT, 1, 400) // contributor
  await grant(PROJECT, 2, 400)
  return { asha: await jwtFor("asha"), juma: await jwtFor("juma"), outsider: await jwtFor("outsider") }
}

describe("edit history", () => {
  it("starts empty, stores a copy, and hands it back", async () => {
    const { asha } = await setup()
    const empty = await req("GET", "", asha)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ revision: 0, history: null })

    const put = await req("PUT", "", asha, { baseRevision: 0, history: doc(["Trim take"]) })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ revision: 1 })

    const got = await req("GET", "", asha)
    expect(await got.json()).toEqual({ revision: 1, history: doc(["Trim take"]) })
    // Nothing new since revision 1: the cheap answer.
    const since = await req("GET", "?since=1", asha)
    expect(await since.json()).toEqual({ revision: 1, unchanged: true })
  })

  it("refuses a write built on an older revision and returns the current copy to merge with", async () => {
    const { asha } = await setup()
    await req("PUT", "", asha, { baseRevision: 0, history: doc(["From A"]) })
    // Device B also thinks there is no copy yet.
    const late = await req("PUT", "", asha, { baseRevision: 0, history: doc(["From B"]) })
    expect(late.status).toBe(409)
    expect(await late.json()).toMatchObject({ revision: 1, history: doc(["From A"]) })
    // Built on revision 1 it lands, and the next is 2.
    const merged = await req("PUT", "", asha, { baseRevision: 1, history: doc(["From A", "From B"]) })
    expect(await merged.json()).toEqual({ revision: 2 })
    const stale = await req("PUT", "", asha, { baseRevision: 1, history: doc(["Stale"]) })
    expect(stale.status).toBe(409)
  })

  it("keeps each person's history to themselves", async () => {
    const { asha, juma } = await setup()
    await req("PUT", "", asha, { baseRevision: 0, history: doc(["Asha's step"]) })
    const theirs = await req("GET", "", juma)
    expect(await theirs.json()).toEqual({ revision: 0, history: null })
    await req("PUT", "", juma, { baseRevision: 0, history: doc(["Juma's step"]) })
    const mine = await req("GET", "", asha)
    expect(await mine.json()).toEqual({ revision: 1, history: doc(["Asha's step"]) })
  })

  it("refuses people outside the project, the agent channel, and malformed copies", async () => {
    const { asha, outsider } = await setup()
    expect((await req("GET", "", outsider)).status).toBe(403)
    expect((await req("PUT", "", outsider, { baseRevision: 0, history: doc([]) })).status).toBe(403)
    expect((await req("GET", "", asha, undefined, { "x-aquilla-agent-run": "run-1" })).status).toBe(403)
    expect((await req("PUT", "", asha, { baseRevision: -1, history: doc([]) })).status).toBe(400)
    expect((await req("PUT", "", asha, { baseRevision: 0, history: { undo: [] } })).status).toBe(400)
  })
})
