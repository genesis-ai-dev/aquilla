// AQU-1775 — a Monday connection belongs to the deployment that made it.
//
// The dev Neon branch is restored from production, so dev's integration tables
// are production's: every org's encrypted Monday tokens, decryptable with the
// signing key the two environments share. Before this, dev's cron, the
// sync-worker nudge and every settings push would have refreshed a copied
// token (rotating production's away) and written dev's numbers onto a board
// linked on production. The gate lives in the ONE accessor every Monday call
// path uses, and fires before any decrypt, refresh or fetch.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { encryptMondayToken } from "../lib/monday/crypto"
import {
  foreignConnectionError,
  getConnectionAccessToken,
  MondayForeignConnectionError,
  runningEnvironment,
} from "../lib/monday/tokens"
import { pushBoardLink } from "../lib/monday/push"
import type { IntegrationConnectionRow, IntegrationLinkRow } from "../lib/monday/types"
import type { Env } from "../types"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Any network call is a failure: the gate must answer before Monday is asked anything. */
function forbidFetch() {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    throw new Error(`unexpected fetch in test: ${url}`)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

/** org 1 (wendi owner 700, anna maintainer 600) + proj-1. */
async function seedOrgProject() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 600, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Ruth Translation', 1, 1)",
  ).run()
}

/**
 * A connection row as the given deployment made it. Expired by default, so a
 * refresh (the call that would rotate the other deployment's token) is due.
 */
async function seedConnection(
  environment: string | null,
  opts: { expiresInMs: number | null } = { expiresInMs: -60_000 },
): Promise<IntegrationConnectionRow> {
  const accessEnc = await encryptMondayToken(env.SECRET_KEY, "monday-plain-token")
  const refreshEnc = await encryptMondayToken(env.SECRET_KEY, "refresh-tok-1")
  const expiresAt =
    opts.expiresInMs != null ? new Date(Date.now() + opts.expiresInMs).toISOString() : null
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections
       (id, org_id, provider, account, access_token_enc, refresh_token_enc, access_token_expires_at, created_by, environment)
     VALUES ('conn-1', '1', 'monday', '{"accountSlug":"acme"}', ?, ?, ?, 'wendi', ?)`,
  )
    .bind(accessEnc, refreshEnc, expiresAt, environment)
    .run()
  return (await env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_connections WHERE id = 'conn-1'",
  ).first<IntegrationConnectionRow>())!
}

const baseConfig = {
  version: 1,
  itemGranularity: "project",
  columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" }],
}

/** An enabled, DIRTY link on conn-1 — exactly what the cron flush would pick up. */
async function seedDirtyLink(): Promise<IntegrationLinkRow> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_links
       (id, project_id, provider, connection_id, external_id, external_name, config, created_by, dirty_at)
     VALUES ('link-1', 'proj-1', 'monday', 'conn-1', 'board-9', 'Ruth Board', ?, 'wendi', now())`,
  )
    .bind(JSON.stringify(baseConfig))
    .run()
  return (await env.AQUILLA_PG.prepare(
    "SELECT * FROM integration_links WHERE id = 'link-1'",
  ).first<IntegrationLinkRow>())!
}

const needsReauth = async (): Promise<boolean> =>
  (await env.AQUILLA_PG.prepare(
    "SELECT needs_reauth FROM integration_connections WHERE id = 'conn-1'",
  ).first<{ needs_reauth: boolean }>())!.needs_reauth

const workerEnv = env as unknown as Env

describe("runningEnvironment", () => {
  it("is the profile's ENVIRONMENT, except that a local stack is always 'local'", () => {
    expect(runningEnvironment({ ENVIRONMENT: "development", WRANGLER_LOCAL: undefined })).toBe("development")
    // dev-stack and e2e run with WRANGLER_LOCAL=1 on top of a profile whose
    // ENVIRONMENT says "development" (the top-level profile even says
    // "production"). A local database must never pass as a deployment's.
    expect(runningEnvironment({ ENVIRONMENT: "production", WRANGLER_LOCAL: "1" })).toBe("local")
    expect(runningEnvironment({ ENVIRONMENT: undefined, WRANGLER_LOCAL: undefined })).toBe("unknown")
  })
})

describe("foreignConnectionError", () => {
  it("accepts a row this deployment made, and only production accepts a pre-0175 row", () => {
    expect(foreignConnectionError({ ENVIRONMENT: "development" }, { environment: "development" })).toBeNull()
    expect(foreignConnectionError({ ENVIRONMENT: "production" }, { environment: null })).toBeNull()
    const onDev = foreignConnectionError({ ENVIRONMENT: "development" }, { environment: null })
    expect(onDev).toBeInstanceOf(MondayForeignConnectionError)
    expect(onDev!.message).toMatch(/an unknown environment; refusing to use it from development/)
  })

  it("refuses a row another deployment made, naming both sides", () => {
    const err = foreignConnectionError({ ENVIRONMENT: "development" }, { environment: "production" })
    expect(err).toBeInstanceOf(MondayForeignConnectionError)
    expect(err!.connectionEnvironment).toBe("production")
    expect(err!.runningEnvironment).toBe("development")
    expect(err!.message).toBe(
      "Monday connection was made on production; refusing to use it from development",
    )
  })
})

describe("getConnectionAccessToken (the one accessor every Monday call path uses)", () => {
  it("refuses a production row BEFORE any refresh or fetch, and never marks needs_reauth", async () => {
    await seedOrgProject()
    const conn = await seedConnection("production") // expired: a refresh would be due
    const fetchSpy = forbidFetch()
    await expect(getConnectionAccessToken(workerEnv, conn)).rejects.toBeInstanceOf(
      MondayForeignConnectionError,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    // The row is fine where it came from; a refresh failure would have flagged it.
    expect(await needsReauth()).toBe(false)
  })

  it("decrypts a row this deployment made", async () => {
    await seedOrgProject()
    const conn = await seedConnection(runningEnvironment(workerEnv), { expiresInMs: null })
    forbidFetch()
    expect(await getConnectionAccessToken(workerEnv, conn)).toBe("monday-plain-token")
  })
})

describe("the push engine", () => {
  it("records a foreign connection as a permanent push error: no Monday call, no retry, dirty_at cleared", async () => {
    await seedOrgProject()
    await seedConnection("production")
    const link = await seedDirtyLink()
    const fetchSpy = forbidFetch()

    const result = await pushBoardLink(workerEnv, link)
    expect(result.ok).toBe(false)
    expect(result.pushed).toBe(false)
    expect(result.retryScheduled).toBeUndefined()
    expect(result.error).toMatch(/made on production/)
    expect(fetchSpy).not.toHaveBeenCalled()

    const after = (await env.AQUILLA_PG.prepare(
      `SELECT dirty_at, push_attempts, next_retry_at, last_push_status, last_push_error
         FROM integration_links WHERE id = 'link-1'`,
    ).first<{
      dirty_at: string | null
      push_attempts: number
      next_retry_at: string | null
      last_push_status: string | null
      last_push_error: string | null
    }>())!
    expect(after.last_push_status).toBe("error")
    expect(after.last_push_error).toMatch(/made on production; refusing to use it from/)
    // Permanent: the cron must not pick it up again every five minutes.
    expect(after.dirty_at).toBeNull()
    expect(after.push_attempts).toBe(0)
    expect(after.next_retry_at).toBeNull()
    expect(await needsReauth()).toBe(false)
  })
})

describe("the routes", () => {
  it("report the row's environment and that it is unusable here; a Monday call answers 409 without re-auth", async () => {
    await seedOrgProject()
    await seedConnection("production")
    const fetchSpy = forbidFetch()
    const headers = authHeader(await jwtFor("anna"))

    const status = await app.request("/api/v2/monday/orgs/1/connection", { headers }, env)
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ connected: true, environment: "production", usable: false })

    const boards = await app.request("/api/v2/monday/orgs/1/boards", { headers }, env)
    expect(boards.status).toBe(409)
    const body = (await boards.json()) as {
      foreignConnection?: boolean
      needsReauth?: boolean
      connectionEnvironment?: string
    }
    expect(body.foreignConnection).toBe(true)
    expect(body.connectionEnvironment).toBe("production")
    // Not a re-auth problem: sending someone to Monday would not help.
    expect(body.needsReauth).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("still lets the org disconnect a copied row, without calling Monday", async () => {
    await seedOrgProject()
    await seedConnection("production")
    const fetchSpy = forbidFetch()
    const res = await app.request(
      "/api/v2/monday/orgs/1/connection",
      { method: "DELETE", headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: true })
    expect(fetchSpy).not.toHaveBeenCalled()
    const left = await env.AQUILLA_PG.prepare(
      "SELECT count(*)::int AS n FROM integration_connections",
    ).first<{ n: number }>()
    expect(left!.n).toBe(0)
  })
})
