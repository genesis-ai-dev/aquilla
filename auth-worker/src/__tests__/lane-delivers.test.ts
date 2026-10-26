// Media redesign slice 1 (Sam, Oct 22): each target language says what it
// DELIVERS — Text, Audio, or Text and audio — on its row of Project settings →
// Languages, in place of AQU-1954's "Records audio" switch. Saved on the lane
// row under the same permission as every other change to the Languages card
// (P1.8), relayed so open overviews re-read (P1.1), and written together with
// `records_audio` so that column's readers stay in step.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "p-delivers"

let restoreSyncWorkerUrl: (() => void) | null = null

function captureNotifications(): string[] {
  const previous = env.SYNC_WORKER_URL
  restoreSyncWorkerUrl = () => { env.SYNC_WORKER_URL = previous }
  env.SYNC_WORKER_URL = "https://sync.test"
  env.SYNC_SECRET_KEY ??= "test-secret"
  const notified: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const match = url.match(/\/admin\/projects\/([^/]+)\/settings-changed$/)
    if (match) notified.push(decodeURIComponent(match[1]))
    return new Response(null, { status: 200 })
  })
  return notified
}

afterEach(() => {
  vi.restoreAllMocks()
  restoreSyncWorkerUrl?.()
  restoreSyncWorkerUrl = null
})

/**
 * Owner (700) and maintainer (600) of the org; a project lead (500) and a
 * contributor (400) on the project. `floor` is the org's languageEditMinRole,
 * absent by default (Project lead).
 */
async function seed(floor?: number) {
  await seedUser(1, "owner")
  await seedUser(2, "mia")
  await seedUser(3, "lee")
  await seedUser(4, "ana")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 0, 1)",
  ).bind(floor == null ? "{}" : JSON.stringify({ languageEditMinRole: floor })).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Ruth', 1, 1)",
  ).bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
     VALUES (?, 3, 500, 1), (?, 4, 400, 1)`,
  ).bind(PROJECT, PROJECT).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', ?, 'source', 'English', NULL, NULL, NULL, 0),
      ('ln-fr', ?, 'target', 'French', NULL, NULL, '', 1),
      ('ln-sw', ?, 'target', 'Swahili', NULL, NULL, 'sw', 2)`,
  ).bind(PROJECT, PROJECT, PROJECT).run()
}

async function setDelivers(user: string, laneId: string, delivers: unknown) {
  return app.request(
    `/api/v2/projects/${PROJECT}/lanes/${laneId}/delivers`,
    {
      method: "POST",
      headers: authHeader(await jwtFor(user)),
      body: JSON.stringify({ delivers }),
    },
    env,
  )
}

async function stored(laneId: string): Promise<{ delivers: string | null; records_audio: boolean } | null> {
  return await env.AQUILLA_PG.prepare(
    "SELECT delivers, records_audio FROM lanes WHERE project_id = ? AND id = ?",
  ).bind(PROJECT, laneId).first<{ delivers: string | null; records_audio: boolean }>()
}

async function settingsLanes(user: string): Promise<Array<{ id: string; delivers?: string | null }>> {
  const res = await app.request(
    `/api/v2/projects/${PROJECT}/settings`,
    { headers: authHeader(await jwtFor(user)) },
    env,
  )
  const body = (await res.json()) as { lanes?: Array<{ id: string; delivers?: string | null }> }
  return body.lanes ?? []
}

describe("POST /projects/:id/lanes/:laneId/delivers", () => {
  beforeEach(async () => {
    await seed()
  })

  it("starts every language at Text", async () => {
    expect(await stored("ln-fr")).toEqual({ delivers: "text", records_audio: false })
    expect(await stored("ln-sw")).toEqual({ delivers: "text", records_audio: false })
  })

  it("sets one language to Audio, leaves the others alone, and tells open screens", async () => {
    const notified = captureNotifications()
    const res = await setDelivers("lee", "ln-sw", "audio")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { lane: { delivers?: string } }).lane.delivers).toBe("audio")
    expect(await stored("ln-sw")).toEqual({ delivers: "audio", records_audio: true })
    expect(await stored("ln-fr")).toEqual({ delivers: "text", records_audio: false })
    expect(notified).toEqual([PROJECT])
    // What another browser re-reads after the relay.
    const lanes = await settingsLanes("mia")
    expect(lanes.find((lane) => lane.id === "ln-sw")?.delivers).toBe("audio")
    expect(lanes.find((lane) => lane.id === "ln-fr")?.delivers).toBe("text")
  })

  it("writes Records audio with it: on for Audio and Text and audio, off for Text", async () => {
    await setDelivers("lee", "ln-sw", "text_and_audio")
    expect(await stored("ln-sw")).toEqual({ delivers: "text_and_audio", records_audio: true })
    await setDelivers("lee", "ln-sw", "text")
    expect(await stored("ln-sw")).toEqual({ delivers: "text", records_audio: false })
  })

  it("settles a language that had Records audio on and no choice yet", async () => {
    await env.AQUILLA_PG.prepare(
      "UPDATE lanes SET delivers = NULL, records_audio = true WHERE id = 'ln-sw'",
    ).run()
    expect((await settingsLanes("lee")).find((lane) => lane.id === "ln-sw")?.delivers).toBeNull()
    expect((await setDelivers("lee", "ln-sw", "text_and_audio")).status).toBe(200)
    expect(await stored("ln-sw")).toEqual({ delivers: "text_and_audio", records_audio: true })
  })

  it("deletes nothing: switching back and forth leaves every recording and every line of text", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, lane_id, value, event_id, last_edit_at)
       VALUES (?, 'f1', 'c1', 'target', 'ln-sw', 'Habari', 'e1', 1)`,
    ).bind(PROJECT).run()
    await setDelivers("lee", "ln-sw", "text")
    await setDelivers("lee", "ln-sw", "audio")
    const row = await env.AQUILLA_PG.prepare(
      "SELECT value FROM cells WHERE project_id = ? AND cell_id = 'c1' AND lane_id = 'ln-sw'",
    ).bind(PROJECT).first<{ value: string }>()
    expect(row?.value).toBe("Habari")
  })

  it("refuses a Contributor, who can see the choice but not change it", async () => {
    const res = await setDelivers("ana", "ln-sw", "audio")
    expect(res.status).toBe(403)
    expect(await stored("ln-sw")).toEqual({ delivers: "text", records_audio: false })
  })

  it("refuses the source language and an unknown one", async () => {
    expect((await setDelivers("lee", "ln-src", "audio")).status).toBe(404)
    expect((await setDelivers("lee", "ln-missing", "audio")).status).toBe(404)
  })

  it("refuses anything but the three choices", async () => {
    expect((await setDelivers("lee", "ln-sw", "video")).status).toBe(400)
    expect((await setDelivers("lee", "ln-sw", null)).status).toBe(400)
    expect(await stored("ln-sw")).toEqual({ delivers: "text", records_audio: false })
  })
})

describe("the Delivers choice under a stricter language floor", () => {
  it("refuses a Project lead when the org asks for a Maintainer", async () => {
    await seed(600)
    expect((await setDelivers("lee", "ln-sw", "audio")).status).toBe(403)
    expect(await stored("ln-sw")).toEqual({ delivers: "text", records_audio: false })
    expect((await setDelivers("mia", "ln-sw", "audio")).status).toBe(200)
  })
})

describe("POST /projects/:id/lanes takes each new language's choice", () => {
  beforeEach(async () => {
    await seed()
  })

  async function createLane(language: string, delivers?: string) {
    return app.request(
      `/api/v2/projects/${PROJECT}/lanes`,
      {
        method: "POST",
        headers: authHeader(await jwtFor("lee")),
        body: JSON.stringify({ name: "", language, ...(delivers ? { delivers } : {}) }),
      },
      env,
    )
  }

  it("stores the choice it is sent", async () => {
    const res = await createLane("Tok Pisin", "audio")
    expect(res.status).toBe(201)
    const lane = ((await res.json()) as { lane: { id: string; delivers?: string } }).lane
    expect(lane.delivers).toBe("audio")
    expect(await stored(lane.id)).toEqual({ delivers: "audio", records_audio: true })
  })

  it("is Text when no choice is sent", async () => {
    const res = await createLane("German")
    const lane = ((await res.json()) as { lane: { id: string; delivers?: string } }).lane
    expect(await stored(lane.id)).toEqual({ delivers: "text", records_audio: false })
  })
})
