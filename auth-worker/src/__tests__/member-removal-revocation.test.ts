// AQU-346: removing a member must actually revoke their access.
//
// WHY these tests exist: in the 2026-06-12 group session, an owner removed a
// member and the removed user kept full access ("you didn't kick me").
// Enforcement has three legs; this file pins the two identity-side legs:
//
//   1. Mint-time: a removed user's NEXT sync-token mint must 403 — tokens are
//      the only credential the sync-worker trusts, so minting is the front
//      door of revocation.
//   2. Propagation: the removal routes must notify the sync-worker (which
//      ejects live WS sessions + denylists outstanding tokens) — but ONLY
//      when no AD-12 grant path survives; a user who keeps org/group/creator
//      access is still a member and must not be ejected.
//
// (Leg 3 — the sync-worker's POST /events membership re-check — is pinned in
// sync-worker/src/__tests__/membership-revocation.test.ts.)
//
// Also pinned here: the `src` claim on minted tokens, which the sync-worker
// uses for the documented platform-admin exemption.

import { env } from "cloudflare:test"
import { afterEach, describe, it, expect, vi } from "vitest"
import { verify } from "hono/jwt"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const SYNC_SECRET = "sync-secret"
const SYNC_WORKER_URL = "https://sync-worker.test"

async function seedProjectWithMember(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "bob")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-r', 'Revoke', NULL, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-r', 2, 400, 1)",
  ).run()
}

function envWithSyncWorker(): typeof env {
  return { ...env, SYNC_WORKER_URL } as typeof env
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })))
  vi.stubGlobal("fetch", fetchSpy)
  return fetchSpy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AQU-346 — revocation bites at the sync-token mint", () => {
  it("mints for a member, then 403s the same user after their row is removed", async () => {
    await seedProjectWithMember()
    const jwt = await jwtFor("bob")

    const before = await app.request(
      "/api/v2/sync-token",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId: "proj-r", fileId: "f1" }) },
      env,
    )
    expect(before.status).toBe(200)

    // The removal (what DELETE /members/:userId performs).
    await env.AQUILLA_PG.prepare(
      "DELETE FROM project_members WHERE project_id = 'proj-r' AND user_id = 2",
    ).run()

    // Removed → the very next mint is refused. This is the front door of
    // revocation: without a mintable token, reload cannot restore access.
    const after = await app.request(
      "/api/v2/sync-token",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId: "proj-r", fileId: "f1" }) },
      env,
    )
    expect(after.status).toBe(403)
  })

  it("stamps the role-resolution source as the `src` claim (platform-exemption transport)", async () => {
    await seedProjectWithMember()
    const res = await app.request(
      "/api/v2/sync-token",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ projectId: "proj-r", fileId: "f1" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string }
    const claims = (await verify(body.token, SYNC_SECRET, "HS256")) as { src?: string }
    expect(claims.src).toBe("override")
  })
})

describe("AQU-346 — removal routes notify the sync-worker (live-session eject)", () => {
  it("DELETE /members/:userId notifies when no grant path survives", async () => {
    await seedProjectWithMember()
    const fetchSpy = stubFetch()

    const res = await app.request(
      "/api/v2/projects/proj-r/members/2",
      { method: "DELETE", headers: authHeader(await jwtFor("owner")) },
      envWithSyncWorker(),
    )
    expect(res.status).toBe(200)
    // Let the best-effort promise settle (no ExecutionContext in tests).
    await new Promise((r) => setTimeout(r, 0))

    const call = fetchSpy.mock.calls.find(
      (c) => String(c[0]).includes("/admin/projects/proj-r/member-removed"),
    )
    expect(call).toBeDefined()
    const init = call![1] as RequestInit
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${SYNC_SECRET}` })
    expect(JSON.parse(String(init.body))).toEqual({ userId: 2, username: "bob" })
  })

  it("DELETE /members/:userId does NOT notify when an org grant survives (AD-12: still a member)", async () => {
    await seedProjectWithMember()
    // Attach the project to an org where bob keeps access.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (9, 'Org', 1)",
    ).run()
    await env.AQUILLA_PG.prepare("UPDATE projects SET org_id = 9 WHERE id = 'proj-r'").run()
    await env.AQUILLA_PG.prepare(
      // AQU-435: only a Maintainer+ org role survives as a grant path.
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (9, 2, 600, 1)",
    ).run()
    const fetchSpy = stubFetch()

    const res = await app.request(
      "/api/v2/projects/proj-r/members/2",
      { method: "DELETE", headers: authHeader(await jwtFor("owner")) },
      envWithSyncWorker(),
    )
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 0))

    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).includes("member-removed")),
    ).toBe(false)
  })

  it("revoke-all notifies when the direct row was the only path", async () => {
    await seedProjectWithMember()
    const fetchSpy = stubFetch()

    const res = await app.request(
      "/api/v2/projects/proj-r/members/2/revoke-all",
      { method: "POST", headers: authHeader(await jwtFor("owner")), body: "{}" },
      envWithSyncWorker(),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { removed: boolean }).removed).toBe(true)
    await new Promise((r) => setTimeout(r, 0))

    const call = fetchSpy.mock.calls.find(
      (c) => String(c[0]).includes("/admin/projects/proj-r/member-removed"),
    )
    expect(call).toBeDefined()
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      userId: 2,
      username: "bob",
    })
  })

  it("revoke-all does NOT notify when an org grant survives", async () => {
    await seedProjectWithMember()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (9, 'Org', 1)",
    ).run()
    await env.AQUILLA_PG.prepare("UPDATE projects SET org_id = 9 WHERE id = 'proj-r'").run()
    await env.AQUILLA_PG.prepare(
      // AQU-435: only a Maintainer+ org role survives as a grant path.
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (9, 2, 600, 1)",
    ).run()
    const fetchSpy = stubFetch()

    const res = await app.request(
      "/api/v2/projects/proj-r/members/2/revoke-all",
      { method: "POST", headers: authHeader(await jwtFor("owner")), body: "{}" },
      envWithSyncWorker(),
    )
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 0))

    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).includes("member-removed")),
    ).toBe(false)
  })
})
