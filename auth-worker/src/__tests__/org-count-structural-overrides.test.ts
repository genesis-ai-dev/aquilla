// AQU-1083 — the org default reaching projects that opted out of it.
//
// A project with its own countStructuralCells is deliberately deaf to the org
// switch. That is correct, and it is also how the switch becomes a change
// nobody can see: an owner flips it and the projects that most needed it do
// not move. So the org settings GET reports how many projects have their own
// answer, and this endpoint clears those overrides on request.
//
// It CLEARS rather than stamping the new value in. Writing the value into each
// project would leave them all holding an explicit answer and deaf to the NEXT
// change — the same silent miss, deferred. These tests pin that.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const RESET = "/api/v2/orgs/1/settings/count-structural/reset-project-overrides"

/**
 * Capture the sync-worker notifications a request fires.
 *
 * Stubs `fetch` rather than mocking the notify module, so this exercises the
 * real early-return on a missing SYNC_WORKER_URL and the real URL shape —
 * which is the thing a project's realtime room is actually keyed on.
 */
let restoreSyncWorkerUrl: (() => void) | null = null

function captureNotifications() {
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

// The env object is shared across this file's tests. Leaving SYNC_WORKER_URL
// set would send every later test's best-effort notify at a real DNS lookup
// for a host that does not exist.
afterEach(() => {
  vi.restoreAllMocks()
  restoreSyncWorkerUrl?.()
  restoreSyncWorkerUrl = null
})

async function seed() {
  await seedUser(1, "olive") // org owner
  await seedUser(2, "mara")  // org maintainer
  await seedUser(3, "cora")  // contributor, no org role
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
}

/** `overriding` carries its own answer; `inheriting` does not. */
async function seedProjects() {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('p-over','Genesis',1,1), ('p-inherit','Exodus',1,1), ('p-archived','Old',1,1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "UPDATE projects SET archived_at = now() WHERE id = 'p-archived'",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version) VALUES
       ('p-over', ?, 3),
       ('p-inherit', ?, 1),
       ('p-archived', ?, 1)`,
  ).bind(
    JSON.stringify({ countStructuralCells: false, sourceLanguage: "en" }),
    JSON.stringify({ sourceLanguage: "en" }),
    JSON.stringify({ countStructuralCells: false }),
  ).run()
}

const getSettings = async (who: string) =>
  app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor(who)) }, env)

const reset = async (who: string) =>
  app.request(RESET, { method: "POST", headers: authHeader(await jwtFor(who)) }, env)

const patchOrg = async (who: string, settings: Record<string, unknown>, ifMatchVersion = 0) =>
  app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(who)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )

const storedFor = async (projectId: string) =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM project_settings WHERE project_id = ?")
      .bind(projectId).first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

describe("org settings reports how many projects override the structural default", () => {
  it("counts only the projects that carry their own answer", async () => {
    await seed()
    await seedProjects()
    const body = (await (await getSettings("mara")).json()) as { countStructuralOverrides: number }
    // p-over counts. p-inherit has no key. p-archived is archived, and
    // prompting about a project nobody can open would be noise.
    expect(body.countStructuralOverrides).toBe(1)
  })

  it("reports zero when every project inherits", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1','Genesis',1,1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version) VALUES ('p1', '{}', 0)",
    ).run()
    const body = (await (await getSettings("mara")).json()) as { countStructuralOverrides: number }
    // Zero is what suppresses the prompt entirely — a dialog that reports
    // nothing affected is worse than no dialog.
    expect(body.countStructuralOverrides).toBe(0)
  })
})

describe("clearing the per-project overrides", () => {
  it("removes the key so the project inherits again", async () => {
    await seed()
    await seedProjects()
    const res = await reset("mara")
    expect(res.status).toBe(200)
    expect((await res.json() as { cleared: number }).cleared).toBe(1)

    const stored = await storedFor("p-over")
    // The key is GONE, not set to the org's current value. That is what keeps
    // the project following the next change too.
    expect("countStructuralCells" in stored).toBe(false)
  })

  it("leaves every other setting on that project alone", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    expect((await storedFor("p-over")).sourceLanguage).toBe("en")
  })

  it("bumps the version so an editor holding the old one is told", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    const row = await env.AQUILLA_PG
      .prepare("SELECT version FROM project_settings WHERE project_id = 'p-over'")
      .first<{ version: number }>()
    expect(Number(row?.version)).toBe(4)
  })

  it("does not touch a project that was already inheriting", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    const row = await env.AQUILLA_PG
      .prepare("SELECT version FROM project_settings WHERE project_id = 'p-inherit'")
      .first<{ version: number }>()
    expect(Number(row?.version)).toBe(1)
  })

  it("leaves archived projects out of it", async () => {
    await seed()
    await seedProjects()
    await reset("mara")
    expect((await storedFor("p-archived")).countStructuralCells).toBe(false)
  })

  it("reports nothing to do rather than failing", async () => {
    await seed()
    const res = await reset("mara")
    expect(res.status).toBe(200)
    expect((await res.json() as { cleared: number }).cleared).toBe(0)
  })

  it("403s anyone below the gate that sets the default itself", async () => {
    await seed()
    await seedProjects()
    const res = await reset("cora")
    expect(res.status).toBe(403)
    // And the override survives.
    expect((await storedFor("p-over")).countStructuralCells).toBe(false)
  })

  it("lets an owner do it too", async () => {
    await seed()
    await seedProjects()
    expect((await reset("olive")).status).toBe(200)
  })

  it("tells the cleared projects' rooms to re-read", async () => {
    await seed()
    await seedProjects()
    const notified = captureNotifications()
    await reset("mara")
    // Only the project whose override was actually removed. The inheriting one
    // did not change, and nobody is editing the archived one.
    expect(notified).toEqual(["p-over"])
  })
})

// AQU-1083 — the org switch reaching editors that are ALREADY OPEN.
//
// This is the half the reset dialog does not cover. A project with no override
// resolves its policy through the org, and until now nothing told it the org
// had changed: the org PATCH notified no project at all, so every open
// workspace kept painting the old answer until someone reloaded.
describe("flipping the org default notifies the projects that inherit it", () => {
  it("notifies exactly the inheriting, non-archived projects", async () => {
    await seed()
    await seedProjects()
    const notified = captureNotifications()
    expect((await patchOrg("mara", { countStructuralCells: false })).status).toBe(200)
    // p-over has its own answer and is deliberately deaf to this switch;
    // p-archived is nobody's open editor.
    expect(notified).toEqual(["p-inherit"])
  })

  it("includes a project that has no settings row at all", async () => {
    // The inheriting set is driven FROM projects, not from project_settings —
    // a project that never had a settings row is the purest inheritor there
    // is, and an inner join would have hidden exactly those.
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('p-bare','Bare',1,1)",
    ).run()
    const notified = captureNotifications()
    await patchOrg("mara", { countStructuralCells: false })
    expect(notified).toEqual(["p-bare"])
  })

  it("says nothing when the value did not actually change", async () => {
    // The client patch is a whole-object read-modify-write, so this key rides
    // along on every unrelated org settings save. Waking every project room in
    // the org each time someone edits some other setting would be a real cost.
    await seed()
    await seedProjects()
    await patchOrg("mara", { countStructuralCells: false })

    const notified = captureNotifications()
    const res = await patchOrg("mara", { countStructuralCells: false, orgTimezone: "UTC" }, 1)
    expect(res.status).toBe(200)
    expect(notified).toEqual([])
  })

  it("notifies when the key is removed, which is also a change of the default", async () => {
    await seed()
    await seedProjects()
    await patchOrg("mara", { countStructuralCells: false })

    const notified = captureNotifications()
    // Back to unset — the org falls to "count them", which is just as much a
    // move for an inheriting project as flipping it the other way.
    expect((await patchOrg("mara", {}, 1)).status).toBe(200)
    expect(notified).toEqual(["p-inherit"])
  })
})
