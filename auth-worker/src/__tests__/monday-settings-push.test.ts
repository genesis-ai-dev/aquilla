// AQU-1771: a settings change that moves the numbers on a Monday board pushes
// that board right away (after the response), instead of leaving it dirty for
// the 5-minute cron. Only dirty links are pushed, links in an AQU-1828 retry
// backoff are left to the cron, and a failing push never fails the save.

import { env } from "cloudflare:test"
import { afterEach, describe, it, expect, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { encryptMondayToken } from "../lib/monday/crypto"
import { pushDirtyLinksNow } from "../lib/monday/push"

const config = {
  version: 1,
  itemGranularity: "project",
  columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" }],
}

async function seed() {
  await seedUser(1, "olive")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1), (2, 'Other', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (2,1,700,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('p-a', 'Genesis', 1, 1), ('p-b', 'Exodus', 1, 1), ('p-other', 'Ruth', 2, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version) VALUES
       ('p-a', '{}', 1), ('p-b', '{}', 1), ('p-other', '{}', 1)`,
  ).run()
  const token = await encryptMondayToken(env.SECRET_KEY, "monday-plain-token")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by) VALUES
       ('c1', '1', 'monday', '{}', ?, 'olive'), ('c2', '2', 'monday', '{}', ?, 'olive')`,
  )
    .bind(token, token)
    .run()
  for (const [id, projectId, conn] of [
    ["l-a", "p-a", "c1"],
    ["l-b", "p-b", "c1"],
    ["l-other", "p-other", "c2"],
  ]) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO integration_links (id, project_id, provider, connection_id, external_id, config, created_by)
       VALUES (?, ?, 'monday', ?, 'board', ?, 'olive')`,
    )
      .bind(id, projectId, conn, JSON.stringify(config))
      .run()
  }
}

/** Monday answers every create with a new item id; sync-worker notices succeed. */
function mockMonday(opts: { failMonday?: boolean } = {}) {
  const mondayBodies: string[] = []
  let nextId = 900
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const body = typeof init?.body === "string" ? init.body : ""
    if (url.startsWith("https://api.monday.com/v2")) {
      mondayBodies.push(body)
      if (opts.failMonday) return new Response("upstream down", { status: 503 })
      const aliases = [...body.matchAll(/\b(c\d+):\s*create_item/g)].map((m) => m[1])
      const data = Object.fromEntries(aliases.map((alias) => [alias, { id: String(nextId++) }]))
      return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
    }
    return new Response("{}", { status: 200 })
  })
  vi.stubGlobal("fetch", fn)
  return { mondayBodies }
}

/** An ExecutionContext whose background work the test can wait for. */
function collectingCtx() {
  const pending: Promise<unknown>[] = []
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    settle: () => Promise.all(pending),
  }
}

const linkState = async (id: string) =>
  env.AQUILLA_PG.prepare(
    "SELECT dirty_at, last_pushed_at, next_retry_at FROM integration_links WHERE id = ?",
  )
    .bind(id)
    .first<{ dirty_at: string | null; last_pushed_at: string | null; next_retry_at: string | null }>()

const patchProject = async (ctx: ExecutionContext, projectId: string, settings: Record<string, unknown>) =>
  app.request(
    `/api/v2/projects/${projectId}/settings`,
    {
      method: "PATCH",
      headers: authHeader(await jwtFor("olive")),
      body: JSON.stringify({ settings, ifMatchVersion: 1 }),
    },
    env,
    ctx,
  )

afterEach(() => vi.unstubAllGlobals())

describe("Monday boards update right after a settings change (AQU-1771)", () => {
  it("a project's validation count change pushes that board now", async () => {
    await seed()
    const { mondayBodies } = mockMonday()
    const { ctx, settle } = collectingCtx()
    expect((await patchProject(ctx, "p-a", { validationCount: 2 })).status).toBe(200)
    await settle()
    expect(mondayBodies.length).toBeGreaterThan(0)
    const link = await linkState("l-a")
    expect(link!.dirty_at).toBeNull()
    expect(link!.last_pushed_at).not.toBeNull()
    expect((await linkState("l-b"))!.last_pushed_at).toBeNull()
  })

  it("a save that changes nothing the board shows pushes nothing", async () => {
    await seed()
    const { mondayBodies } = mockMonday()
    const { ctx, settle } = collectingCtx()
    expect((await patchProject(ctx, "p-a", { autoPropagateRepetitions: true })).status).toBe(200)
    await settle()
    expect(mondayBodies).toEqual([])
  })

  it("the org's headings rule pushes every board in that org and none in another", async () => {
    await seed()
    mockMonday()
    const { ctx, settle } = collectingCtx()
    const res = await app.request(
      "/api/v2/orgs/1/settings",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("olive")),
        body: JSON.stringify({ settings: { countStructuralCells: false }, ifMatchVersion: 0 }),
      },
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    await settle()
    expect((await linkState("l-a"))!.last_pushed_at).not.toBeNull()
    expect((await linkState("l-b"))!.last_pushed_at).not.toBeNull()
    expect((await linkState("l-other"))!.last_pushed_at).toBeNull()
  })

  it("an org-wide push stops at the cap and leaves the rest dirty for the cron", async () => {
    await seed()
    mockMonday()
    await env.AQUILLA_PG.prepare("UPDATE integration_links SET dirty_at = now()").run()
    expect(await pushDirtyLinksNow(env, { orgId: 1 }, 1)).toBe(1)
    const states = await Promise.all(["l-a", "l-b"].map(linkState))
    expect(states.filter((s) => s!.dirty_at === null)).toHaveLength(1)
    expect(states.filter((s) => s!.dirty_at !== null)).toHaveLength(1)
    expect((await linkState("l-other"))!.dirty_at).not.toBeNull()
  })

  it("a board waiting out a retry backoff is left for the cron", async () => {
    await seed()
    const { mondayBodies } = mockMonday()
    await env.AQUILLA_PG.prepare(
      "UPDATE integration_links SET next_retry_at = now() + interval '10 minutes' WHERE id = 'l-a'",
    ).run()
    const { ctx, settle } = collectingCtx()
    expect((await patchProject(ctx, "p-a", { validationCount: 2 })).status).toBe(200)
    await settle()
    expect(mondayBodies).toEqual([])
    expect((await linkState("l-a"))!.dirty_at).not.toBeNull()
  })

  it("the save still succeeds when Monday is down, and the board stays queued", async () => {
    await seed()
    mockMonday({ failMonday: true })
    const { ctx, settle } = collectingCtx()
    expect((await patchProject(ctx, "p-a", { validationCount: 2 })).status).toBe(200)
    await settle()
    const link = await linkState("l-a")
    expect(link!.dirty_at).not.toBeNull()
    expect(link!.next_retry_at).not.toBeNull()
  })
})

/** Every column_values object the push sent, decoded from the GraphQL bodies. */
function pushedColumnValues(bodies: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const body of bodies) {
    const query = (JSON.parse(body) as { query?: string }).query ?? ""
    for (const m of query.matchAll(/column_values: ("(?:[^"\\]|\\.)*")/g)) {
      out.push(JSON.parse(JSON.parse(m[1]!) as string) as Record<string, unknown>)
    }
  }
  return out
}

describe("the project deadline on a Monday board (AQU-1770)", () => {
  async function seedDeadlineColumn() {
    await env.AQUILLA_PG.prepare("UPDATE integration_links SET config = ? WHERE id = 'l-a'")
      .bind(
        JSON.stringify({
          ...config,
          columns: [...config.columns, { columnId: "date_1", columnType: "date", metric: "deadline" }],
        }),
      )
      .run()
  }
  const patchDeadline = async (ctx: ExecutionContext, deadline: string | null) =>
    app.request(
      "/api/v2/projects/p-a/deadline",
      { method: "PATCH", headers: authHeader(await jwtFor("olive")), body: JSON.stringify({ deadline }) },
      env,
      ctx,
    )

  it("setting a deadline pushes that board now, with the date", async () => {
    await seed()
    await seedDeadlineColumn()
    const { mondayBodies } = mockMonday()
    const { ctx, settle } = collectingCtx()
    expect((await patchDeadline(ctx, "2026-10-16")).status).toBe(200)
    await settle()
    expect(pushedColumnValues(mondayBodies).map((v) => v.date_1)).toContainEqual({ date: "2026-10-16" })
    expect((await linkState("l-a"))!.dirty_at).toBeNull()
    expect((await linkState("l-b"))!.last_pushed_at).toBeNull()
  })

  it("clearing the deadline clears the board's cell", async () => {
    await seed()
    await seedDeadlineColumn()
    await env.AQUILLA_PG.prepare("UPDATE projects SET deadline_at = '2026-10-16' WHERE id = 'p-a'").run()
    const { mondayBodies } = mockMonday()
    const { ctx, settle } = collectingCtx()
    expect((await patchDeadline(ctx, null)).status).toBe(200)
    await settle()
    const values = pushedColumnValues(mondayBodies).filter((v) => "date_1" in v)
    expect(values.length).toBeGreaterThan(0)
    expect(values.every((v) => v.date_1 === "")).toBe(true)
  })
})

describe("project facts on a Monday board (AQU-1770)", () => {
  it("clearing the project manager pushes the board now, with link and schedule in Monday's formats", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("UPDATE projects SET pm_user_id = 1 WHERE id = 'p-a'").run()
    await env.AQUILLA_PG.prepare("UPDATE integration_links SET config = ? WHERE id = 'l-a'")
      .bind(
        JSON.stringify({
          ...config,
          columns: [
            ...config.columns,
            { columnId: "pm_1", columnType: "text", metric: "project_manager" },
            { columnId: "link_1", columnType: "link", metric: "project_link" },
            { columnId: "status_9", columnType: "status", metric: "schedule_status" },
            { columnId: "date_9", columnType: "date", metric: "next_target_date" },
          ],
        }),
      )
      .run()
    const { mondayBodies } = mockMonday()
    const { ctx, settle } = collectingCtx()
    const res = await app.request(
      "/api/v2/projects/p-a/pm",
      { method: "PATCH", headers: authHeader(await jwtFor("olive")), body: JSON.stringify({ pmUserId: null }) },
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    await settle()
    const values = pushedColumnValues(mondayBodies).find((v) => "pm_1" in v)!
    expect(values.pm_1).toBe("")
    expect(values.link_1).toEqual({ url: expect.stringMatching(/\/projects\/p-a$/), text: "Open in Aquilla" })
    expect(values.status_9).toEqual({ label: "On track" })
    expect(values.date_9).toBe("")
    expect((await linkState("l-a"))!.dirty_at).toBeNull()
  })
})
