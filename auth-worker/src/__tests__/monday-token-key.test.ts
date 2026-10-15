// AQU-1775 — MONDAY_TOKEN_KEY: a deployment that sets it encrypts Monday
// tokens under a key no other deployment holds. Production, local and e2e
// leave it unset and keep the SECRET_KEY derivation. The environment gate
// (monday-environment-gate.test.ts) is the first line; this is the
// cryptographic second: a production token copied to dev is unreadable there
// even if the gate were bypassed, because dev's Monday key differs.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { seedUser } from "./helpers/db"
import {
  decryptMondayToken,
  encryptMondayToken,
  mondayTokenKeyMaterial,
} from "../lib/monday/crypto"
import { getConnectionAccessToken, persistTokenSet, runningEnvironment } from "../lib/monday/tokens"
import { pushBoardLink } from "../lib/monday/push"
import type { IntegrationConnectionRow, IntegrationLinkRow } from "../lib/monday/types"
import type { Env } from "../types"

afterEach(() => {
  vi.unstubAllGlobals()
})

const workerEnv = env as unknown as Env
/** The dev worker: the same SECRET_KEY as production, plus a Monday key of its own. */
const devEnv: Env = { ...workerEnv, MONDAY_TOKEN_KEY: "dev-only-monday-key" }

function forbidFetch() {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    throw new Error(`unexpected fetch in test: ${url}`)
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

async function seedOrgProject() {
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-1', 'Ruth Translation', 1, 1)",
  ).run()
}

/**
 * A connection whose tokens were encrypted the way PRODUCTION encrypts them
 * (the SECRET_KEY derivation), stamped as made here so the environment gate
 * lets it through — only the key stands between dev and the token. Legacy
 * non-expiring, so the read never enters the refresh path.
 */
async function seedConnectionUnderSecretKey(): Promise<IntegrationConnectionRow> {
  const accessEnc = await encryptMondayToken(env.SECRET_KEY, "monday-plain-token")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO integration_connections
       (id, org_id, provider, account, access_token_enc, created_by, environment)
     VALUES ('conn-1', '1', 'monday', '{"accountSlug":"acme"}', ?, 'wendi', ?)`,
  )
    .bind(accessEnc, runningEnvironment(workerEnv))
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

describe("mondayTokenKeyMaterial", () => {
  it("falls back to SECRET_KEY when unset or blank, and uses MONDAY_TOKEN_KEY when set", () => {
    expect(mondayTokenKeyMaterial({ SECRET_KEY: "s", MONDAY_TOKEN_KEY: undefined })).toBe("s")
    expect(mondayTokenKeyMaterial({ SECRET_KEY: "s", MONDAY_TOKEN_KEY: "   " })).toBe("s")
    expect(mondayTokenKeyMaterial({ SECRET_KEY: "s", MONDAY_TOKEN_KEY: " k " })).toBe("k")
  })
})

describe("with MONDAY_TOKEN_KEY set", () => {
  it("stores tokens under the Monday key, which SECRET_KEY cannot open", async () => {
    await seedOrgProject()
    const conn = await seedConnectionUnderSecretKey()
    await persistTokenSet(devEnv, conn.id, {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      scope: null,
      expiresAt: null,
    })
    const row = (await env.AQUILLA_PG.prepare(
      "SELECT access_token_enc, refresh_token_enc FROM integration_connections WHERE id = 'conn-1'",
    ).first<{ access_token_enc: string; refresh_token_enc: string }>())!
    expect(await decryptMondayToken(mondayTokenKeyMaterial(devEnv), row.access_token_enc)).toBe("new-access")
    expect(await decryptMondayToken(mondayTokenKeyMaterial(devEnv), row.refresh_token_enc)).toBe("new-refresh")
    await expect(decryptMondayToken(env.SECRET_KEY, row.access_token_enc)).rejects.toThrow()
  })

  it("cannot read a token encrypted the way production encrypts it, even when the environment matches", async () => {
    await seedOrgProject()
    const conn = await seedConnectionUnderSecretKey()
    const fetchSpy = forbidFetch()
    // Readable where SECRET_KEY is the derivation (production's shape)…
    expect(await getConnectionAccessToken(workerEnv, conn)).toBe("monday-plain-token")
    // …and not on the deployment that has a Monday key of its own.
    await expect(getConnectionAccessToken(devEnv, conn)).rejects.toThrow()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("the push engine records a permanent decrypt failure and never calls Monday", async () => {
    await seedOrgProject()
    await seedConnectionUnderSecretKey()
    const link = await seedDirtyLink()
    const fetchSpy = forbidFetch()

    const result = await pushBoardLink(devEnv, link)
    expect(result).toMatchObject({ ok: false, pushed: false, linked: true, error: "token decrypt failed" })
    expect(fetchSpy).not.toHaveBeenCalled()

    const after = (await env.AQUILLA_PG.prepare(
      "SELECT dirty_at, last_push_status, last_push_error, next_retry_at FROM integration_links WHERE id = 'link-1'",
    ).first<{ dirty_at: string | null; last_push_status: string | null; last_push_error: string | null; next_retry_at: string | null }>())!
    expect(after.last_push_status).toBe("error")
    expect(after.last_push_error).toMatch(/^token decrypt failed/)
    expect(after.dirty_at).toBeNull()
    expect(after.next_retry_at).toBeNull()
  })
})
