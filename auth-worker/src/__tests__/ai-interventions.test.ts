// Contract tests for the AI intervention audit trail (AQU-1656).
//
// What matters: a translator can always see what the AI was asked and what it
// said for a cell, and nothing in that trail leaks across a project boundary.
// A batch call drafts many cells from ONE prompt, so the trace is stored once
// and every cell's row must lead back to it.

import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import app from "../index"
import { ROLE } from "../types"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { traceKey, type AiInterventionRow } from "../routes/ai-interventions"

const PROJECT = "trail-project"
const OTHER = "other-project"

class FakeBucket {
  store = new Map<string, string>()
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async get(key: string): Promise<{ json: () => Promise<unknown> } | null> {
    const v = this.store.get(key)
    return v === undefined ? null : { json: async () => JSON.parse(v) }
  }
}

async function seedProject(projectId: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, "Trail", createdBy)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

const batchCall = {
  callId: "call-1",
  kind: "draft",
  mode: "batch",
  model: "test-model",
  provider: "frontier",
  messages: [
    { role: "system", content: "You translate Greek into English." },
    { role: "user", content: "<v1>ἀπεκρίθη αὐτοῖς ὁ Ἰησοῦς</v1>\n<v2>ἐργάζεσθε μὴ τὴν βρῶσιν</v2>" },
  ],
  rawOutput: "<v1>Jesus answered them, “Truly…</v1>\n<v2>Do not work for the food that perishes…”</v2>",
  cells: [
    { interventionId: "iv-26", fileId: "JHN", cellId: "JHN 6:26", basedOnEventId: "e-26", output: "Jesus answered them, “Truly…", exampleCellIds: ["JHN 5:19"] },
    { interventionId: "iv-27", fileId: "JHN", cellId: "JHN 6:27", basedOnEventId: null, output: "Do not work for the food that perishes…”", exampleCellIds: [] },
  ],
}

async function req(path: string, jwt: string, bucket: FakeBucket, init: RequestInit = {}): Promise<Response> {
  return await app.request(
    path,
    { ...init, headers: authHeader(jwt) },
    { ...env, SNAPSHOTS: bucket },
  )
}

const record = (projectId: string, jwt: string, bucket: FakeBucket, body: unknown = batchCall) =>
  req(`/api/v2/projects/${projectId}/ai-interventions`, jwt, bucket, { method: "POST", body: JSON.stringify(body) })

describe("ai interventions", () => {
  it("one batch call → one stored trace, one row per drafted cell, each leading back to the prompt", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    const jwt = await jwtFor("contrib")
    const bucket = new FakeBucket()

    const res = await record(PROJECT, jwt, bucket)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, traceStored: true })
    expect([...bucket.store.keys()]).toEqual([traceKey(PROJECT, "call-1")])

    const list = await req(`/api/v2/projects/${PROJECT}/cells/${encodeURIComponent("JHN 6:27")}/ai-interventions`, jwt, bucket)
    const { interventions } = (await list.json()) as { interventions: AiInterventionRow[] }
    expect(interventions).toHaveLength(1)
    expect(interventions[0]).toMatchObject({
      id: "iv-27",
      callId: "call-1",
      mode: "batch",
      model: "test-model",
      output: "Do not work for the food that perishes…”",
      basedOnEventId: null,
      hasTrace: true,
      userId: "2",
    })

    const trace = await req(`/api/v2/projects/${PROJECT}/ai-interventions/iv-26/trace`, jwt, bucket)
    expect(trace.status).toBe(200)
    expect(await trace.json()).toEqual({ messages: batchCall.messages, output: batchCall.rawOutput })
  })

  it("lists a cell's interventions newest first, with the examples each draft used", async () => {
    await seedUser(1, "owner")
    await seedProject(PROJECT, 1)
    const jwt = await jwtFor("owner")
    const bucket = new FakeBucket()

    await record(PROJECT, jwt, bucket)
    await new Promise((r) => setTimeout(r, 5))
    await record(PROJECT, jwt, bucket, {
      ...batchCall,
      callId: "call-2",
      mode: "single",
      cells: [{ ...batchCall.cells[0], interventionId: "iv-26-redo", exampleCellIds: ["JHN 5:19", "JHN 5:24"] }],
    })

    const list = await req(`/api/v2/projects/${PROJECT}/cells/${encodeURIComponent("JHN 6:26")}/ai-interventions`, jwt, bucket)
    const { interventions } = (await list.json()) as { interventions: AiInterventionRow[] }
    expect(interventions.map((i) => i.id)).toEqual(["iv-26-redo", "iv-26"])
    expect(interventions[0].exampleCellIds).toEqual(["JHN 5:19", "JHN 5:24"])
  })

  it("a viewer can read the trail but cannot write to it", async () => {
    await seedUser(1, "owner")
    await seedUser(3, "viewer")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 3, ROLE.VIEWER)
    const bucket = new FakeBucket()
    await record(PROJECT, await jwtFor("owner"), bucket)

    const viewer = await jwtFor("viewer")
    expect((await record(PROJECT, viewer, bucket, { ...batchCall, callId: "call-v" })).status).toBe(403)
    const list = await req(`/api/v2/projects/${PROJECT}/cells/${encodeURIComponent("JHN 6:26")}/ai-interventions`, viewer, bucket)
    expect(list.status).toBe(200)
  })

  it("a trace cannot be read through another project, even by a member of both", async () => {
    await seedUser(1, "owner")
    await seedProject(PROJECT, 1)
    await seedProject(OTHER, 1)
    const jwt = await jwtFor("owner")
    const bucket = new FakeBucket()
    await record(PROJECT, jwt, bucket)

    const res = await req(`/api/v2/projects/${OTHER}/ai-interventions/iv-26/trace`, jwt, bucket)
    expect(res.status).toBe(404)
  })

  it("a non-member sees nothing", async () => {
    await seedUser(1, "owner")
    await seedUser(4, "stranger")
    await seedProject(PROJECT, 1)
    const bucket = new FakeBucket()
    await record(PROJECT, await jwtFor("owner"), bucket)

    const stranger = await jwtFor("stranger")
    const list = await req(`/api/v2/projects/${PROJECT}/cells/${encodeURIComponent("JHN 6:26")}/ai-interventions`, stranger, bucket)
    expect(list.status).toBe(403)
    expect((await req(`/api/v2/projects/${PROJECT}/ai-interventions/iv-26/trace`, stranger, bucket)).status).toBe(403)
  })

  it("still records the rows when the trace bucket is unavailable, and says the trace is missing", async () => {
    await seedUser(1, "owner")
    await seedProject(PROJECT, 1)
    const jwt = await jwtFor("owner")
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/ai-interventions`,
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify(batchCall) },
      { ...env, SNAPSHOTS: undefined },
    )
    expect(await res.json()).toEqual({ ok: true, traceStored: false })
    const trace = await app.request(
      `/api/v2/projects/${PROJECT}/ai-interventions/iv-26/trace`,
      { headers: authHeader(jwt) },
      { ...env, SNAPSHOTS: undefined },
    )
    expect(trace.status).toBe(404)
    expect(await trace.json()).toMatchObject({ error: "trace_unavailable" })
  })
})
