// AQU-926 — unit coverage for the extracted sync-token mint core
// (services/sync-token-mint.ts). The HTTP route's behavior stays pinned by
// sync-token.test.ts; this suite pins the service the agent harness calls
// directly: the AQU-285 archive/freeze gates, AD-12 resolution, the AQU-553
// scopes claim, and every denial reason the harness must map to a tool error.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { verify } from "hono/jwt"
import {
  mintSyncTokenForUser,
  signSyncTokenWithRole,
  SYNC_TOKEN_TTL_SECONDS,
} from "../services/sync-token-mint"
import type { AuthUser, Env } from "../types"
import { seedUser } from "./helpers/db"

const SYNC_SECRET = "sync-secret"

function authUser(id: number, username: string): AuthUser {
  return {
    id,
    username,
    email: `${username}@example.com`,
    password_hash: "x",
    preferences: {},
    created_at: "",
    updated_at: "",
    password_changed_at: null,
  }
}

async function seedProjectWithMember(roleLevel = 400): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(2, "boss")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 2)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 1, ?)",
  )
    .bind(roleLevel)
    .run()
}

describe("mintSyncTokenForUser", () => {
  it("mints a token with the resolved role; scopes claim omitted when unscoped", async () => {
    await seedProjectWithMember(400)
    const res = await mintSyncTokenForUser(env as unknown as Env, authUser(1, "alice"), "p1", "__project__")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.expiresIn).toBe(SYNC_TOKEN_TTL_SECONDS)
    expect(res.role).toEqual({ level: 400, name: "contributor", source: "override" })
    const claims = (await verify(res.token, SYNC_SECRET, "HS256")) as Record<string, unknown>
    expect(claims).toMatchObject({
      userId: 1,
      username: "alice",
      projectId: "p1",
      fileId: "__project__",
      role: 400,
      src: "override",
      aud: "sync",
    })
    // AQU-553: an absent claim means "unscoped" on the sync-worker side.
    expect(claims.scopes).toBeUndefined()
  })

  it("carries lane/file scope rows into the claim (AQU-553)", async () => {
    await seedProjectWithMember(300)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_at)
       VALUES ('p1', 1, 'lane', 'es', 0), ('p1', 1, 'file', 'f-9', 0)`,
    ).run()
    const res = await mintSyncTokenForUser(env as unknown as Env, authUser(1, "alice"), "p1", "__project__")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const claims = (await verify(res.token, SYNC_SECRET, "HS256")) as {
      scopes?: { kind: string; value: string }[]
    }
    expect(claims.scopes).toEqual([
      { kind: "file", value: "f-9" },
      { kind: "lane", value: "es" },
    ])
  })

  it("denies project_not_found for an unknown project id", async () => {
    await seedUser(1, "alice")
    const res = await mintSyncTokenForUser(env as unknown as Env, authUser(1, "alice"), "nope", "f")
    expect(res).toEqual({ ok: false, reason: "project_not_found" })
  })

  it("denies project_archived before resolving any role", async () => {
    await seedProjectWithMember(700)
    await env.AQUILLA_PG.prepare("UPDATE projects SET archived_at = '2026-01-01' WHERE id = 'p1'").run()
    const res = await mintSyncTokenForUser(env as unknown as Env, authUser(1, "alice"), "p1", "f")
    expect(res).toEqual({ ok: false, reason: "project_archived" })
  })

  it("denies project_frozen when is_active = false (AQU-285)", async () => {
    await seedProjectWithMember(700)
    await env.AQUILLA_PG.prepare("UPDATE projects SET is_active = FALSE WHERE id = 'p1'").run()
    const res = await mintSyncTokenForUser(env as unknown as Env, authUser(1, "alice"), "p1", "f")
    expect(res).toEqual({ ok: false, reason: "project_frozen" })
  })

  it("denies no_access when AD-12 resolution finds nothing", async () => {
    await seedUser(2, "boss")
    await seedUser(3, "outsider")
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 2)").run()
    const res = await mintSyncTokenForUser(env as unknown as Env, authUser(3, "outsider"), "p1", "f")
    expect(res).toEqual({ ok: false, reason: "no_access" })
  })

  it("denies not_configured when SYNC_SECRET_KEY is unset", async () => {
    const bare = Object.assign(Object.create(env), { SYNC_SECRET_KEY: undefined }) as Env
    const res = await mintSyncTokenForUser(bare, authUser(1, "alice"), "p1", "f")
    expect(res).toEqual({ ok: false, reason: "not_configured" })
  })

  // [Pen test 2026-08-18] ids reach R2 key templates verbatim through the
  // token claims; the mint core must reject path characters for EVERY caller,
  // not just the browser route's zod schema (the agent harness's
  // propose_command mints here directly).
  it("denies unsafe_id when projectId or fileId carries path characters", async () => {
    await seedProjectWithMember(700)
    for (const [pid, fid] of [
      ["p1/../other", "f"],
      ["p1", "f/audio"],
      ["p1", ".."],
      ["p1\\evil", "f"],
    ] as const) {
      const res = await mintSyncTokenForUser(env as unknown as Env, authUser(1, "alice"), pid, fid)
      expect(res).toEqual({ ok: false, reason: "unsafe_id" })
    }
  })
})

describe("signSyncTokenWithRole", () => {
  it("signs for a caller-resolved role (the route's auto-register path)", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 1)").run()
    const signed = await signSyncTokenWithRole(
      env as unknown as Env,
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 700, name: "owner", source: "creator" },
    )
    expect(signed.expiresIn).toBe(SYNC_TOKEN_TTL_SECONDS)
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as Record<string, unknown>
    expect(claims).toMatchObject({ userId: 1, projectId: "p1", fileId: "file-a", role: 700, src: "creator" })
  })
})
