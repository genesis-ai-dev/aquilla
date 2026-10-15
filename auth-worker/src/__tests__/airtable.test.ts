// AQU-804: the Airtable integration (routes/airtable.ts, lib/airtable/*).
//
// Airtable is played by helpers/fake-airtable.ts, built from Airtable's API
// reference; global fetch is stubbed per test, so no request leaves the
// process. The DB is the shared PGlite, so the integration_* tables are real.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { fakeAirtableFetch, makeFakeAirtable, type FakeAirtable, type FakeBase } from "./helpers/fake-airtable"
import { airtableTiming, BASE_REQUEST_INTERVAL_MS, resetAirtableThrottle } from "../lib/airtable/client"
import { decryptAirtableToken, encryptAirtableToken } from "../lib/airtable/tokens"
import { pushAirtableLink } from "../lib/airtable/push"
import { flushDirtyLinks } from "../lib/integrations/push"
import { markProjectSyncLinksDirty } from "../../../db/shared/progress-sync-dirty"
import type { IntegrationLinkRow } from "../lib/monday/types"
import type { Env } from "../types"

const aenv = { ...env, OPENROUTER_API_KEY: "test-openrouter-key" } as unknown as Env

const realTiming = { ...airtableTiming }
let slept: number[] = []

beforeEach(() => {
  resetAirtableThrottle()
  slept = []
  airtableTiming.sleep = async (ms: number) => {
    slept.push(ms)
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.assign(airtableTiming, realTiming)
})

const EPISODES = Array.from({ length: 12 }, (_, i) => `Episode ${i + 1}`)

/** The customer's tracker: a name, a progress %, a status, a due date, notes, a formula. */
function trackerBase(): FakeBase {
  return {
    id: "appCOMEANDSEE001",
    name: "Come & See",
    tables: [
      {
        id: "tblTRACKER000001",
        name: "Translation tracker",
        primaryFieldId: "fldName",
        fields: [
          { id: "fldName", name: "Name", type: "singleLineText" },
          { id: "fldProgress", name: "Progress", type: "percent" },
          { id: "fldStatus", name: "Status", type: "singleSelect" },
          { id: "fldDue", name: "Due", type: "date" },
          { id: "fldNotes", name: "Notes", type: "multilineText" },
          { id: "fldFormula", name: "Days left", type: "formula" },
        ],
      },
      {
        id: "tblISSUES0000001",
        name: "Issues",
        primaryFieldId: "fldIssue",
        fields: [{ id: "fldIssue", name: "Issue", type: "singleLineText" }],
      },
    ],
  }
}

/** Route Airtable to the fake and OpenRouter to `llm`; anything else is a test bug. */
function install(fake: FakeAirtable, llm?: (prompt: string) => unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.startsWith("https://api.airtable.com/")) return fakeAirtableFetch(fake, request)
    if (request.url.startsWith("https://openrouter.ai/") && llm) {
      const body = (await request.json()) as { messages: Array<{ content: string }> }
      const answer = llm(body.messages[0]!.content)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }
    throw new Error(`unexpected fetch in test: ${request.url}`)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

/** wendi=owner(700), anna=maintainer(600), tom=contributor(400); proj-1 in org 1 with 12 episodes. */
async function seedOrgProject() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "tom")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'The Chosen Burmese', 1, 1)",
  ).run()
  for (const [i, name] of EPISODES.entries()) {
    // Episode 1 is 70% done, every other one 50%.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count)
       VALUES (?, 'proj-1', ?, ?, 100, ?, 10)`,
    )
      .bind(`file-${String(i + 1).padStart(2, "0")}`, name, `ev-${i}`, i === 0 ? 70 : 50)
      .run()
  }
}

async function seedConnection(fake: FakeAirtable, environment = "test") {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by, environment)
     VALUES ('conn-at', '1', 'airtable', '{"email":"anna@comeandsee.example"}', ?, 'anna', ?)`,
  )
    .bind(await encryptAirtableToken(env as unknown as Env, fake.token), environment)
    .run()
}

async function seedLink(config: Record<string, unknown>, remoteState: unknown = null): Promise<IntegrationLinkRow> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_links (id, project_id, provider, connection_id, external_id, external_name, config, remote_state, created_by)
     VALUES ('link-at', 'proj-1', 'airtable', 'conn-at', 'appCOMEANDSEE001', 'Translation tracker', ?, ?, 'anna')`,
  )
    .bind(JSON.stringify(config), remoteState == null ? null : JSON.stringify(remoteState))
    .run()
  return (await env.AQUILLA_PG.prepare("SELECT * FROM integration_links WHERE id = 'link-at'").first<IntegrationLinkRow>())!
}

const request = async (username: string, method: string, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(await jwtFor(username)),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    aenv,
  )

const linkState = async () =>
  (await env.AQUILLA_PG.prepare(
    `SELECT dirty_at, push_attempts, next_retry_at, last_push_status, last_push_error, remote_state_stale
       FROM integration_links WHERE id = 'link-at'`,
  ).first<{
    dirty_at: string | null
    push_attempts: number
    next_retry_at: string | null
    last_push_status: string | null
    last_push_error: string | null
    remote_state_stale: boolean
  }>())!

/** Writes (record creates/updates) the fake saw, in order. */
const recordWrites = (fake: FakeAirtable) =>
  fake.requests.filter((r) => (r.method === "POST" || r.method === "PATCH") && !r.path.startsWith("/v0/meta/"))

// A mapping with an Aquilla ID field, as setup always leaves one.
const UPSERT_CONFIG = {
  version: 1,
  tableId: "tblTRACKER000001",
  itemGranularity: "project_and_files",
  matchExisting: { columnId: "fldAquillaId" },
  columns: [
    { columnId: "fldName", columnType: "singleLineText", metric: "project_name" },
    { columnId: "fldProgress", columnType: "percent", metric: "completion_pct" },
    { columnId: "fldStatus", columnType: "singleSelect", metric: "status_auto" },
    { columnId: "fldDue", columnType: "date", metric: "deadline" },
    { columnId: "fldAquillaId", columnType: "singleLineText", metric: "external_id" },
  ],
}

function withAquillaIdField(base: FakeBase): FakeBase {
  base.tables[0]!.fields.push({ id: "fldAquillaId", name: "Aquilla ID", type: "singleLineText" })
  return base
}

// ── Connection ──────────────────────────────────────────────────────────────

describe("connecting an org with a personal access token", () => {
  it("checks the token with Airtable, stores it encrypted, and never hands it back", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    install(fake)

    const res = await request("anna", "PUT", "/api/v2/airtable/orgs/1/connection", { token: `  ${fake.token} ` })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      connected: true,
      account: { email: "anna@comeandsee.example" },
      usable: true,
      baseCount: 1,
    })
    expect(JSON.stringify(body)).not.toContain(fake.token)
    expect(fake.requests.map((r) => r.path)).toEqual(["/v0/meta/whoami", "/v0/meta/bases"])

    const row = (await env.AQUILLA_PG.prepare(
      "SELECT access_token_enc, environment FROM integration_connections WHERE provider = 'airtable'",
    ).first<{ access_token_enc: string; environment: string }>())!
    expect(row.access_token_enc).not.toContain(fake.token)
    expect(await decryptAirtableToken(env as unknown as Env, row.access_token_enc)).toBe(fake.token)
    expect(row.environment).toBe("test")

    const status = await request("tom", "GET", "/api/v2/airtable/orgs/1/connection")
    expect(status.status).toBe(200)
    const text = await status.text()
    expect(text).toContain('"connected":true')
    expect(text).not.toContain(fake.token)
  })

  it("only an org maintainer may connect", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    install(fake)
    const res = await request("tom", "PUT", "/api/v2/airtable/orgs/1/connection", { token: fake.token })
    expect(res.status).toBe(403)
    expect(fake.requests).toEqual([])
  })

  it("a token Airtable rejects is not stored", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    install(fake)
    const res = await request("anna", "PUT", "/api/v2/airtable/orgs/1/connection", { token: "patWRONG.token123" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "token_rejected" })
    const count = await env.AQUILLA_PG.prepare("SELECT COUNT(*) AS n FROM integration_connections").first<{ n: number }>()
    expect(Number(count?.n)).toBe(0)
  })

  it("a token that can't read the bases' structure is refused, naming the scope", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    fake.noSchemaRead = true
    install(fake)
    const res = await request("anna", "PUT", "/api/v2/airtable/orgs/1/connection", { token: fake.token })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "missing_scopes", missingScopes: ["schema.bases:read"] })
  })
})

// ── Link ────────────────────────────────────────────────────────────────────

describe("linking a project to a table", () => {
  it("checks the mapping against the live table and maps the record name and Aquilla ID itself", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    install(fake)

    const res = await request("anna", "PUT", "/api/v2/airtable/projects/proj-1/link", {
      baseId: "appCOMEANDSEE001",
      tableId: "tblTRACKER000001",
      baseName: "Come & See",
      config: {
        version: 1,
        itemGranularity: "file",
        columns: [
          { columnId: "fldProgress", columnType: "percent", metric: "completion_pct" },
          { columnId: "fldFormula", columnType: "formula", metric: "validated_pct" },
          { columnId: "fldGone", columnType: "number", metric: "total_count" },
          { columnId: "fldDue", columnType: "date", metric: "completion_pct" },
        ],
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      link: { baseName: string; tableName: string; tableUrl: string; config: { columns: unknown[]; matchExisting: unknown } }
      warnings: string[]
    }
    expect(body.link).toMatchObject({
      baseName: "Come & See",
      tableName: "Translation tracker",
      tableUrl: "https://airtable.com/appCOMEANDSEE001/tblTRACKER000001",
    })
    expect(body.link.config.columns).toEqual([
      { columnId: "fldProgress", columnType: "percent", metric: "completion_pct" },
      { columnId: "fldAquillaId", columnType: "singleLineText", metric: "external_id" },
      { columnId: "fldName", columnType: "singleLineText", metric: "project_name" },
    ])
    expect(body.link.config.matchExisting).toEqual({ columnId: "fldAquillaId" })
    expect(body.warnings).toHaveLength(3)
    expect(body.warnings.join("\n")).toMatch(/fldFormula.*formula/)
    expect(body.warnings.join("\n")).toMatch(/fldGone.*not found/)
  })

  it("a contributor can see the link but not change it", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    await seedConnection(fake)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-1', 3, 400, 1)",
    ).run()
    install(fake)
    const denied = await request("tom", "PUT", "/api/v2/airtable/projects/proj-1/link", {
      baseId: "appCOMEANDSEE001",
      tableId: "tblTRACKER000001",
      config: { version: 1, itemGranularity: "project", columns: [] },
    })
    expect(denied.status).toBe(403)
    const view = await request("tom", "GET", "/api/v2/airtable/projects/proj-1/link")
    expect(await view.json()).toMatchObject({ linked: false, orgConnected: true })
  })
})

// ── Push ────────────────────────────────────────────────────────────────────

describe("pushing progress into the table", () => {
  it("upserts one record for the project and one per episode, 10 per request, on the Aquilla ID", async () => {
    await seedOrgProject()
    await env.AQUILLA_PG.prepare("UPDATE projects SET deadline_at = '2026-12-01' WHERE id = 'proj-1'").run()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    const link = await seedLink(UPSERT_CONFIG)
    install(fake)

    const result = await pushAirtableLink(aenv, link)
    expect(result).toMatchObject({ ok: true, pushed: true, itemsUpserted: 13 })

    // 13 records → two requests (10 + 3), both upserts merged on the Aquilla ID, typecast on.
    const writes = recordWrites(fake)
    expect(writes.map((w) => (w.body!.records as unknown[]).length)).toEqual([10, 3])
    for (const w of writes) {
      expect(w.method).toBe("PATCH")
      expect(w.body).toMatchObject({ performUpsert: { fieldsToMergeOn: ["fldAquillaId"] }, typecast: true })
    }

    const records = fake.records.get("tblTRACKER000001")!
    expect(records).toHaveLength(13)
    const project = records.find((r) => r.fields.fldAquillaId === "proj-1")!
    // 12 files: 70 + 11×50 = 620 of 1200 cells → 51.7%, a fraction in a percent field.
    expect(project.fields).toMatchObject({
      fldName: "The Chosen Burmese",
      fldProgress: 0.517,
      fldStatus: "In progress",
      fldDue: "2026-12-01",
    })
    const episode1 = records.find((r) => r.fields.fldAquillaId === "file-01")!
    expect(episode1.fields).toMatchObject({ fldName: "The Chosen Burmese — Episode 1", fldProgress: 0.7 })

    const links = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM integration_item_links WHERE link_id = 'link-at'",
    ).first<{ n: number }>()
    expect(Number(links?.n)).toBe(13)
    expect((await linkState()).last_push_status).toBe("ok")

    // The next push updates the same records — nothing is doubled.
    await env.AQUILLA_PG.prepare("UPDATE files SET filled_count = 100 WHERE id = 'file-02'").run()
    const again = await pushAirtableLink(aenv, (await env.AQUILLA_PG.prepare("SELECT * FROM integration_links WHERE id = 'link-at'").first<IntegrationLinkRow>())!)
    expect(again.ok).toBe(true)
    expect(fake.records.get("tblTRACKER000001")).toHaveLength(13)
    expect(records.find((r) => r.fields.fldAquillaId === "file-02")!.fields).toMatchObject({
      fldProgress: 1,
      fldStatus: "Complete",
    })
  })

  it("keeps to Airtable's 5 requests a second per base", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    const link = await seedLink(UPSERT_CONFIG)
    install(fake)
    let clock = 1_000_000
    airtableTiming.now = () => clock
    airtableTiming.sleep = async (ms: number) => {
      slept.push(ms)
      clock += ms
    }

    await pushAirtableLink(aenv, link)
    // Two requests to the same base with no time passing between them: the
    // second waits out the first one's slot.
    expect(recordWrites(fake)).toHaveLength(2)
    expect(slept).toEqual([BASE_REQUEST_INTERVAL_MS])
    expect(BASE_REQUEST_INTERVAL_MS).toBeGreaterThanOrEqual(200)
  })

  it("waits out a 429 and tries again once", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    const link = await seedLink({ ...UPSERT_CONFIG, itemGranularity: "project" })
    install(fake)
    let refused = 0
    fake.fail = (req) =>
      req.method === "PATCH" && refused++ === 0
        ? new Response(JSON.stringify({ errors: [{ error: "RATE_LIMIT_REACHED", message: "Rate limit exceeded" }] }), {
            status: 429,
            headers: { "Retry-After": "7" },
          })
        : null

    const result = await pushAirtableLink(aenv, link)
    expect(result.ok).toBe(true)
    expect(slept).toContain(7000)
    expect(recordWrites(fake)).toHaveLength(2)
  })

  it("a second 429 keeps the link dirty for the backoff retry instead of dropping it", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    const link = await seedLink({ ...UPSERT_CONFIG, itemGranularity: "project" })
    install(fake)
    fake.fail = (req) =>
      req.method === "PATCH"
        ? new Response(JSON.stringify({ errors: [{ error: "RATE_LIMIT_REACHED", message: "Rate limit exceeded" }] }), {
            status: 429,
          })
        : null

    const result = await pushAirtableLink(aenv, link)
    expect(result).toMatchObject({ ok: false, retryScheduled: true })
    expect(slept).toContain(30_000)
    const state = await linkState()
    expect(state.dirty_at).not.toBeNull()
    expect(state.push_attempts).toBe(1)
    expect(Date.parse(state.next_retry_at!)).toBeGreaterThan(Date.now())
  })

  it("without an Aquilla ID field, remembers its records and makes a deleted one again", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    await seedConnection(fake)
    const config = {
      version: 1,
      tableId: "tblTRACKER000001",
      itemGranularity: "file",
      itemNameTemplate: "{fileName}",
      columns: [
        { columnId: "fldName", columnType: "singleLineText", metric: "project_name" },
        { columnId: "fldProgress", columnType: "percent", metric: "completion_pct" },
      ],
    }
    let link = await seedLink(config)
    install(fake)

    expect((await pushAirtableLink(aenv, link)).ok).toBe(true)
    const records = fake.records.get("tblTRACKER000001")!
    expect(records.map((r) => r.fields.fldName).sort()).toEqual([...EPISODES].sort())
    expect(recordWrites(fake).every((w) => w.method === "POST")).toBe(true)

    // Someone deletes Episode 3 in Airtable; the next push updates the other
    // eleven in place and makes Episode 3 again.
    records.splice(2, 1)
    fake.requests.length = 0
    link = (await env.AQUILLA_PG.prepare("SELECT * FROM integration_links WHERE id = 'link-at'").first<IntegrationLinkRow>())!
    expect((await pushAirtableLink(aenv, link)).ok).toBe(true)
    const writes = recordWrites(fake)
    expect(writes.filter((w) => w.method === "PATCH").map((w) => (w.body!.records as unknown[]).length)).toEqual([10, 1])
    expect(writes.filter((w) => w.method === "POST").map((w) => (w.body!.records as unknown[]).length)).toEqual([1])
    expect(fake.records.get("tblTRACKER000001")!.map((r) => r.fields.fldName).sort()).toEqual([...EPISODES].sort())
  })

  it("a field the table no longer has is reported, and the other fields still land", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    const link = await seedLink({
      ...UPSERT_CONFIG,
      itemGranularity: "project",
      columns: [...UPSERT_CONFIG.columns, { columnId: "fldDeleted", columnType: "number", metric: "total_count" }],
    })
    install(fake)

    const result = await pushAirtableLink(aenv, link)
    expect(result.ok).toBe(false)
    const state = await linkState()
    expect(state.remote_state_stale).toBe(true)
    expect(state.last_push_error).toMatch(/fldDeleted/)
    expect(state.dirty_at).toBeNull()
    const project = fake.records.get("tblTRACKER000001")!.find((r) => r.fields.fldAquillaId === "proj-1")
    expect(project?.fields.fldProgress).toBe(0.517)
  })

  it("a token Airtable now rejects asks the org for a new one", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    const link = await seedLink(UPSERT_CONFIG)
    fake.token = "patREVOKED.token"
    install(fake)

    const result = await pushAirtableLink(aenv, link)
    expect(result).toMatchObject({ ok: false })
    expect((await linkState()).dirty_at).toBeNull()
    const conn = await env.AQUILLA_PG.prepare("SELECT needs_reauth FROM integration_connections WHERE id = 'conn-at'").first<{ needs_reauth: boolean }>()
    expect(conn?.needs_reauth).toBe(true)
  })

  it("refuses a connection another deployment made, before touching Airtable (AQU-1775)", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake, "production")
    const link = await seedLink(UPSERT_CONFIG)
    const fetchSpy = install(fake)

    const result = await pushAirtableLink(aenv, link)
    expect(result.error).toMatch(/made on production; refusing to use it from test/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── The triggers Monday uses ────────────────────────────────────────────────

describe("an Airtable link rides Monday's push triggers", () => {
  it("the sync-worker's edit nudge pushes it", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    await seedLink(UPSERT_CONFIG)
    install(fake)

    const res = await app.request(
      "/api/v2/monday/internal/push",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.SYNC_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      },
      aenv,
    )
    expect(await res.json()).toMatchObject({ ok: true, pushed: true, linked: true })
    expect(fake.records.get("tblTRACKER000001")).toHaveLength(13)
  })

  it("settings, language and deadline changes mark it dirty, and the cron flush pushes it", async () => {
    await seedOrgProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version) VALUES ('proj-1', '{}', 1)",
    ).run()
    const fake = makeFakeAirtable({ bases: [withAquillaIdField(trackerBase())] })
    await seedConnection(fake)
    await seedLink(UPSERT_CONFIG)
    install(fake)
    const dirty = async () => (await linkState()).dirty_at != null
    const clear = () => env.AQUILLA_PG.prepare("UPDATE integration_links SET dirty_at = NULL").run()

    const settings = await request("wendi", "PATCH", "/api/v2/projects/proj-1/settings", {
      settings: { validationCount: 2 },
      ifMatchVersion: 1,
    })
    expect(settings.status).toBe(200)
    expect(await dirty()).toBe(true)

    await clear()
    const lane = await request("wendi", "POST", "/api/v2/projects/proj-1/lanes", { name: "Burmese", language: "Burmese", code: "my" })
    expect(lane.status).toBe(201)
    expect(await dirty()).toBe(true)

    await clear()
    const deadline = await request("wendi", "PATCH", "/api/v2/projects/proj-1/deadline", { deadline: "2027-01-31" })
    expect(deadline.status).toBe(200)
    expect(await dirty()).toBe(true)

    expect(await flushDirtyLinks(aenv, 20)).toBe(1)
    expect(await dirty()).toBe(false)
    const project = fake.records.get("tblTRACKER000001")!.find((r) => r.fields.fldAquillaId === "proj-1")
    expect(project?.fields.fldDue).toBe("2027-01-31")
  })

  it("markProjectSyncLinksDirty marks Airtable and Monday links alike", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable()
    await seedConnection(fake)
    await seedLink(UPSERT_CONFIG)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by, environment)
       VALUES ('conn-mon', '1', 'monday', '{}', 'x', 'anna', 'test')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO integration_links (id, project_id, provider, connection_id, external_id, config, created_by)
       VALUES ('link-mon', 'proj-1', 'monday', 'conn-mon', 'board', '{}', 'anna')`,
    ).run()
    await markProjectSyncLinksDirty(env.AQUILLA_PG, ["proj-1"])
    const rows = await env.AQUILLA_PG.prepare(
      "SELECT id FROM integration_links WHERE dirty_at IS NOT NULL ORDER BY id",
    ).all<{ id: string }>()
    expect((rows.results ?? []).map((r) => r.id)).toEqual(["link-at", "link-mon"])
  })
})

// ── Set up with AI ──────────────────────────────────────────────────────────

describe("Set up with AI", () => {
  it("picks the table, then proposes a mapping clamped to the table's real fields", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    fake.records.set("tblTRACKER000001", [
      { id: "recA", fields: { fldName: "Episode 1" } },
      { id: "recB", fields: { fldName: "Episode 2" } },
    ])
    await seedConnection(fake)
    const prompts: string[] = []
    install(fake, (prompt) => {
      prompts.push(prompt)
      if (prompt.includes("Tables available:")) return { tableId: "tblTRACKER000001", reason: "It tracks translation." }
      return {
        mapping: {
          version: 1,
          tableId: "tblSOMETHINGELSE",
          itemGranularity: "file",
          itemNameTemplate: "{fileName}",
          columns: [
            { columnId: "fldProgress", columnType: "percent", metric: "completion_pct" },
            { columnId: "fldStatus", columnType: "singleSelect", metric: "status_auto" },
            { columnId: "fldInvented", columnType: "number", metric: "total_count" },
          ],
          notes: "Episode rows.",
        },
        summary: "One record per episode.",
      }
    })

    const res = await request("anna", "POST", "/api/v2/airtable/projects/proj-1/analyze", {})
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      proposal: { tableId: string; itemGranularity: string; columns: Array<{ columnId: string }> }
      warnings: string[]
      tableReason: string
      structure: { baseName: string; tableName: string; fields: unknown[] }
    }
    expect(body.tableReason).toBe("It tracks translation.")
    expect(body.structure).toMatchObject({ baseName: "Come & See", tableName: "Translation tracker" })
    expect(body.proposal.tableId).toBe("tblTRACKER000001")
    expect(body.proposal.itemGranularity).toBe("file")
    expect(body.proposal.columns.map((c) => c.columnId)).toEqual(["fldProgress", "fldStatus", "fldName"])
    expect(body.warnings.join("\n")).toMatch(/fldInvented.*not found/)
    // The model saw the table's fields and the names its records already use.
    const mappingPrompt = prompts.find((p) => p.includes("Airtable field mapping"))!
    expect(mappingPrompt).toContain('"name":"Progress"')
    expect(mappingPrompt).toContain("Episode 2")
  })

  it("a token that sees no tables gets a 409 that says so", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [] })
    await seedConnection(fake)
    install(fake, () => ({}))
    const res = await request("anna", "POST", "/api/v2/airtable/projects/proj-1/analyze", {})
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ noTables: true })
  })
})

// ── Adding fields ───────────────────────────────────────────────────────────

describe("adding the missing fields", () => {
  it("creates each field with Airtable's type for it, reuses one already there, and always adds Aquilla ID", async () => {
    await seedOrgProject()
    const base = trackerBase()
    base.tables[0]!.fields.push({ id: "fldCompletion", name: "completion %", type: "percent" })
    const fake = makeFakeAirtable({ bases: [base] })
    await seedConnection(fake)
    install(fake)

    const res = await request("anna", "POST", "/api/v2/airtable/projects/proj-1/fields", {
      baseId: "appCOMEANDSEE001",
      tableId: "tblTRACKER000001",
      metrics: ["completion_pct", "status_auto", "schedule_status", "deadline", "active_contributors_30d", "project_link"],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      created: Array<{ metric: string; title: string; columnType: string }>
      reused: Array<{ metric: string; columnId: string }>
      failed: unknown[]
      structure: { fields: Array<{ name: string }> }
    }
    // "completion %" and the tracker's own Status single-select are used as they are.
    expect(body.reused.map((f) => [f.metric, f.columnId])).toEqual([
      ["completion_pct", "fldCompletion"],
      ["status_auto", "fldStatus"],
    ])
    expect(body.created.map((f) => [f.metric, f.title, f.columnType])).toEqual([
      ["schedule_status", "Schedule", "singleSelect"],
      ["deadline", "Deadline", "date"],
      ["active_contributors_30d", "Active contributors (30 days)", "number"],
      ["project_link", "Aquilla project", "url"],
      ["external_id", "Aquilla ID", "singleLineText"],
    ])
    expect(body.failed).toEqual([])
    const creates = fake.requests.filter((r) => r.path.endsWith("/fields")).map((r) => r.body)
    expect(creates[0]).toEqual({
      name: "Schedule",
      type: "singleSelect",
      options: { choices: [{ name: "On track" }, { name: "Due soon" }, { name: "Behind plan" }, { name: "Overdue" }] },
    })
    expect(creates[1]).toEqual({ name: "Deadline", type: "date", options: { dateFormat: { name: "iso" } } })
    expect(body.structure.fields.map((f) => f.name)).toContain("Aquilla ID")
  })

  it("a token without schema.bases:write reports each field it couldn't add", async () => {
    await seedOrgProject()
    const fake = makeFakeAirtable({ bases: [trackerBase()] })
    fake.noSchemaWrite = true
    await seedConnection(fake)
    install(fake)
    const res = await request("anna", "POST", "/api/v2/airtable/projects/proj-1/fields", {
      baseId: "appCOMEANDSEE001",
      tableId: "tblTRACKER000001",
      metrics: ["validated_pct"],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { created: unknown[]; failed: Array<{ title: string; error: string }> }
    expect(body.created).toEqual([])
    expect(body.failed.map((f) => f.title)).toEqual(["Validated %", "Aquilla ID"])
  })
})

// ── Table changes ───────────────────────────────────────────────────────────

describe("table changes since the link was saved", () => {
  it("names a field added in Airtable, and 'Not needed' stops asking about it", async () => {
    await seedOrgProject()
    const base = withAquillaIdField(trackerBase())
    const fake = makeFakeAirtable({ bases: [base] })
    await seedConnection(fake)
    await seedLink(UPSERT_CONFIG, {
      fetchedAt: "2026-10-15T00:00:00.000Z",
      baseId: "appCOMEANDSEE001",
      baseName: "Come & See",
      tableId: "tblTRACKER000001",
      tableName: "Translation tracker",
      primaryFieldId: "fldName",
      fields: base.tables[0]!.fields.map((f) => ({ ...f })),
    })
    base.tables[0]!.fields.push({ id: "fldReviewed", name: "Reviewed %", type: "percent" })
    install(fake)

    const res = await request("anna", "GET", "/api/v2/airtable/projects/proj-1/table-changes")
    expect(await res.json()).toMatchObject({
      structureStale: true,
      newFields: [{ id: "fldReviewed", name: "Reviewed %", type: "percent" }],
    })
    expect((await linkState()).remote_state_stale).toBe(true)

    const dismissed = await request("anna", "POST", "/api/v2/airtable/projects/proj-1/table-changes/dismiss", {
      fieldIds: ["fldReviewed"],
    })
    expect(await dismissed.json()).toMatchObject({ structureStale: false, newFields: [] })
    expect((await linkState()).remote_state_stale).toBe(false)
  })
})
