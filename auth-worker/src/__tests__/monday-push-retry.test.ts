// AQU-1828 — Monday push retry + unlinked-project short circuit.
//
// The regression this guards: recordPushOutcome used to clear `dirty_at` on
// EVERY outcome, so a push that died on a 429 or a Monday 5xx was dropped from
// the cron flush set and the board silently stopped tracking the project.
// Transient failures now keep the link dirty behind an exponential backoff;
// permanent ones still clear it.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { seedUser } from "./helpers/db"
import { encryptMondayToken } from "../lib/monday/crypto"
import {
  flushDirtyLinks,
  isTransientPushError,
  retryDelaySeconds,
  schedulePush,
  MAX_PUSH_ATTEMPTS,
  RETRY_BASE_SECONDS,
  RETRY_MAX_SECONDS,
} from "../lib/monday/push"
import { MondayApiError } from "../lib/monday/client"
import type { Env } from "../types"

afterEach(() => {
  vi.unstubAllGlobals()
})

const baseConfig = {
  version: 1,
  itemGranularity: "project",
  columns: [{ columnId: "numbers_1", columnType: "numbers", metric: "completion_pct" }],
}

/** org 1 + proj-1 + an enabled monday link that has never been pushed. */
async function seedLinkedProject(
  overrides: { pushAttempts?: number; nextRetryAt?: string | null } = {},
): Promise<void> {
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Ruth', 1, 1)",
  ).run()
  const accessEnc = await encryptMondayToken(env.SECRET_KEY, "monday-plain-token")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections (id, org_id, provider, account, access_token_enc, created_by)
     VALUES ('conn-1', '1', 'monday', '{"accountSlug":"acme"}', ?, 'wendi')`,
  )
    .bind(accessEnc)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_links
       (id, project_id, provider, connection_id, external_id, external_name, config, created_by,
        push_attempts, next_retry_at)
     VALUES ('link-1', 'proj-1', 'monday', 'conn-1', 'board-9', 'Ruth Board', ?, 'wendi', ?, ?)`,
  )
    .bind(
      JSON.stringify(baseConfig),
      overrides.pushAttempts ?? 0,
      overrides.nextRetryAt ?? null,
    )
    .run()
}

type LinkState = {
  dirty_at: string | null
  push_attempts: number
  next_retry_at: string | null
  last_push_status: string | null
  last_push_error: string | null
}

const linkState = async (): Promise<LinkState> =>
  (await env.AQUILLA_PG.prepare(
    `SELECT dirty_at, push_attempts, next_retry_at, last_push_status, last_push_error
       FROM integration_links WHERE id = 'link-1'`,
  ).first<LinkState>())!

/** Every Monday API call returns `status`; anything else throws. */
function mockMonday(status: number, body: unknown = { errors: [{ message: "boom" }] }) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith("https://api.monday.com/v2")) {
      throw new Error(`unexpected fetch in test: ${url}`)
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

describe("retryDelaySeconds", () => {
  it("doubles per consecutive attempt and clamps at the ceiling", () => {
    expect(retryDelaySeconds(1)).toBe(RETRY_BASE_SECONDS)
    expect(retryDelaySeconds(2)).toBe(RETRY_BASE_SECONDS * 2)
    expect(retryDelaySeconds(3)).toBe(RETRY_BASE_SECONDS * 4)
    expect(retryDelaySeconds(MAX_PUSH_ATTEMPTS)).toBe(RETRY_MAX_SECONDS)
  })
})

describe("isTransientPushError", () => {
  it("treats rate limits, server faults and network throws as retryable", () => {
    expect(isTransientPushError(new MondayApiError("slow down", 429))).toBe(true)
    expect(isTransientPushError(new MondayApiError("bad gateway", 502))).toBe(true)
    expect(isTransientPushError(new MondayApiError("Complexity budget exhausted", 200))).toBe(true)
    expect(isTransientPushError(new TypeError("fetch failed"))).toBe(true)
  })

  it("does not retry a rejected query", () => {
    expect(isTransientPushError(new MondayApiError("Column 'numbers_1' not found", 200))).toBe(false)
    expect(isTransientPushError(new MondayApiError("unauthorized", 401))).toBe(false)
  })
})

describe("transient push failure", () => {
  it("keeps the link dirty and schedules a retry (was: dirty_at cleared, never retried)", async () => {
    await seedLinkedProject()
    mockMonday(429, { error_message: "rate limit exceeded" })

    const result = await schedulePush(env as unknown as Env, "proj-1")
    expect(result.ok).toBe(false)
    expect(result.retryScheduled).toBe(true)

    const link = await linkState()
    expect(link.dirty_at).not.toBeNull()
    expect(link.push_attempts).toBe(1)
    expect(link.next_retry_at).not.toBeNull()
    expect(Date.parse(link.next_retry_at!)).toBeGreaterThan(Date.now())
    expect(link.last_push_status).toBe("error")
  })

  it("the cron flush retries it once the backoff has elapsed, and clears on success", async () => {
    await seedLinkedProject()
    mockMonday(429, { error_message: "rate limit exceeded" })
    await schedulePush(env as unknown as Env, "proj-1")
    expect((await linkState()).push_attempts).toBe(1)

    // Still inside the backoff window: the flush must skip it.
    expect(await flushDirtyLinks(env as unknown as Env)).toBe(0)

    // Monday recovers and the backoff lapses.
    await env.AQUILLA_PG.prepare(
      "UPDATE integration_links SET next_retry_at = now() - interval '1 second' WHERE id = 'link-1'",
    ).run()
    mockMonday(200, { data: { c0: { id: "901" } } })

    expect(await flushDirtyLinks(env as unknown as Env)).toBe(1)
    const link = await linkState()
    expect(link.last_push_status).toBe("ok")
    expect(link.dirty_at).toBeNull()
    expect(link.push_attempts).toBe(0)
    expect(link.next_retry_at).toBeNull()
  })

  it("gives up after MAX_PUSH_ATTEMPTS so one bad board cannot occupy the flush cap", async () => {
    await seedLinkedProject({ pushAttempts: MAX_PUSH_ATTEMPTS - 1 })
    mockMonday(503, { error_message: "service unavailable" })

    const result = await schedulePush(env as unknown as Env, "proj-1")
    expect(result.retryScheduled).toBe(false)

    const link = await linkState()
    expect(link.dirty_at).toBeNull()
    expect(link.push_attempts).toBe(0)
    expect(link.next_retry_at).toBeNull()
    expect(link.last_push_status).toBe("error")
  })

  it("does not retry a permanent failure (bad mapping config)", async () => {
    await seedLinkedProject()
    await env.AQUILLA_PG.prepare(
      "UPDATE integration_links SET config = '{\"version\":1}'::jsonb WHERE id = 'link-1'",
    ).run()
    const fetchMock = mockMonday(200, {})

    const result = await schedulePush(env as unknown as Env, "proj-1")
    expect(result.ok).toBe(false)
    expect(result.retryScheduled).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()

    const link = await linkState()
    expect(link.dirty_at).toBeNull()
    expect(link.next_retry_at).toBeNull()
  })

  it("an edit-driven nudge inside the backoff window only marks dirty", async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    await seedLinkedProject({ pushAttempts: 2, nextRetryAt: future })
    const fetchMock = mockMonday(200, {})

    const result = await schedulePush(env as unknown as Env, "proj-1")
    expect(result).toMatchObject({ ok: true, pushed: false, linked: true, retryScheduled: true })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await linkState()).dirty_at).not.toBeNull()
  })
})

describe("unlinked project", () => {
  it("answers linked:false so the DO can stop nudging, and touches no board", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Ruth', 1, 1)",
    ).run()
    const fetchMock = mockMonday(200, {})

    expect(await schedulePush(env as unknown as Env, "proj-1")).toEqual({
      ok: true,
      pushed: false,
      linked: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("answers linked:true for a project that has a link", async () => {
    await seedLinkedProject()
    mockMonday(200, { data: { c0: { id: "901" } } })
    const result = await schedulePush(env as unknown as Env, "proj-1")
    expect(result.linked).toBe(true)
  })
})
