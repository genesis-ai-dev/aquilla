// AQU-1954: "Records audio" on one language row (Project settings →
// Languages). Saved on the lane row, under the same permission as every other
// change to the Languages card, and relayed so open overviews re-read.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "p-lane-audio"

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

beforeEach(async () => {
  await seedUser(1, "owner")
  await seedUser(2, "translator")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Audio', NULL, 1)",
  ).bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 2, 400)",
  ).bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', ?, 'source', 'English', NULL, NULL, NULL, 0),
      ('ln-de', ?, 'target', 'German', NULL, NULL, '', 1),
      ('ln-tpi', ?, 'target', 'Tok Pisin', NULL, NULL, 'tpi', 2)`,
  ).bind(PROJECT, PROJECT, PROJECT).run()
})

async function setRecordsAudio(user: string, laneId: string, recordsAudio: unknown) {
  return app.request(
    `/api/v2/projects/${PROJECT}/lanes/${laneId}/records-audio`,
    {
      method: "POST",
      headers: authHeader(await jwtFor(user)),
      body: JSON.stringify({ recordsAudio }),
    },
    env,
  )
}

async function stored(laneId: string): Promise<boolean | null> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT records_audio FROM lanes WHERE project_id = ? AND id = ?",
  ).bind(PROJECT, laneId).first<{ records_audio: boolean }>()
  return row?.records_audio ?? null
}

describe("POST /projects/:id/lanes/:laneId/records-audio (AQU-1954)", () => {
  it("is off for every language until someone turns it on", async () => {
    expect(await stored("ln-de")).toBe(false)
    expect(await stored("ln-tpi")).toBe(false)
  })

  it("turns one language on, leaves the others alone, and tells open screens", async () => {
    const notified = captureNotifications()
    const res = await setRecordsAudio("owner", "ln-tpi", true)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { lane: { recordsAudio?: boolean } }).lane.recordsAudio).toBe(true)
    expect(await stored("ln-tpi")).toBe(true)
    expect(await stored("ln-de")).toBe(false)
    expect(notified).toEqual([PROJECT])
  })

  it("turns it back off", async () => {
    await setRecordsAudio("owner", "ln-de", true)
    const res = await setRecordsAudio("owner", "ln-de", false)
    expect(res.status).toBe(200)
    expect(await stored("ln-de")).toBe(false)
  })

  it("refuses someone below the Languages card's floor", async () => {
    const res = await setRecordsAudio("translator", "ln-de", true)
    expect(res.status).toBe(403)
    expect(await stored("ln-de")).toBe(false)
  })

  it("refuses the source language and an unknown one", async () => {
    expect((await setRecordsAudio("owner", "ln-src", true)).status).toBe(404)
    expect((await setRecordsAudio("owner", "ln-missing", true)).status).toBe(404)
  })

  it("refuses anything but a boolean", async () => {
    expect((await setRecordsAudio("owner", "ln-de", "yes")).status).toBe(400)
    expect(await stored("ln-de")).toBe(false)
  })
})
