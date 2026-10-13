// AQU-1816: a lane created or renamed through the lane-row endpoints relays to
// the project's realtime room the way the settings PATCH and the archive route
// already do. Without it, a workspace open in another tab (or for another
// member) kept listing the old lanes until a reload — the sync-worker's
// settings-changed frame is the only thing that reaches it.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "p-lane-notify"

/**
 * Capture the sync-worker notifications a request fires. Stubs `fetch` rather
 * than the notify module, so the real URL shape — what a project's realtime
 * room is keyed on — is what gets asserted.
 */
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
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Notify', NULL, 1)",
  )
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position) VALUES
      ('ln-src', ?, 'source', 'Greek', NULL, NULL, NULL, 0),
      ('ln-fr', ?, 'target', 'French', NULL, NULL, 'French', 1)`,
  )
    .bind(PROJECT, PROJECT)
    .run()
})

describe("lane-row writes relay to the sync-worker (AQU-1816)", () => {
  it("creating a lane notifies the project's room", async () => {
    const notified = captureNotifications()
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/lanes`,
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ name: "", language: "Spanish" }),
      },
      env,
    )
    expect(res.status).toBe(201)
    expect(notified).toEqual([PROJECT])
  })

  it("renaming a lane notifies the project's room", async () => {
    const notified = captureNotifications()
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/lanes/ln-fr`,
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ name: "Français" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { lane: { name: string | null } }).lane.name).toBe("Français")
    expect(notified).toEqual([PROJECT])
  })

  it("a refused rename notifies nobody", async () => {
    const notified = captureNotifications()
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/lanes/ln-missing`,
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("owner")),
        body: JSON.stringify({ name: "Nope" }),
      },
      env,
    )
    expect(res.status).toBe(404)
    expect(notified).toEqual([])
  })
})
