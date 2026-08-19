// [Pen test 2026-08-17] POST /admin/projects/:projectId/member-role-changed —
// identity calls this after upserting a project_members row with a new
// role_level so the live ProjectSync DO can update a connected user's cached
// role in place (see project-do.ts ConnectionState.role, gated by
// focus.claim/focus.renew).
//
// WHY: without this hook, a demoted-but-still-connected member keeps
// whatever focus-lock privileges their old (higher) role granted until the
// socket reconnects. This is the role-change companion to member-removed.ts.

import { describe, it, expect } from "vitest"
import {
  handleMemberRoleChangedRequest,
  type MemberRoleChangedEnv,
  type MemberRoleChangedMarker,
} from "../member-role-changed"

function makeEnv(secret = "shared-secret"): MemberRoleChangedEnv {
  return {
    SYNC_SECRET_KEY: secret,
    ProjectSync: {} as unknown as DurableObjectNamespace,
  }
}

function makeRequest(
  projectId: string,
  body: unknown,
  auth = "Bearer k",
  method = "POST",
): Request {
  return new Request(`https://worker/admin/projects/${projectId}/member-role-changed`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  })
}

describe("POST /admin/projects/:projectId/member-role-changed", () => {
  it("requires a matching Authorization header", async () => {
    const res = (await handleMemberRoleChangedRequest(
      makeRequest("p1", { userId: 2, role: 200 }, "Bearer wrong"),
      makeEnv("k"),
      async () => {},
    ))!
    expect(res.status).toBe(401)
  })

  it("rejects non-POST methods", async () => {
    const res = (await handleMemberRoleChangedRequest(
      makeRequest("p1", undefined, "Bearer k", "GET"),
      makeEnv("k"),
      async () => {},
    ))!
    expect(res.status).toBe(405)
  })

  it("returns null for non-matching paths so the caller can fall through", async () => {
    const res = await handleMemberRoleChangedRequest(
      new Request("https://worker/admin/projects/p1/archive", {
        method: "POST",
        headers: { Authorization: "Bearer k" },
        body: "{}",
      }),
      makeEnv("k"),
      async () => {},
    )
    expect(res).toBeNull()
  })

  it("rejects a body missing userId or role", async () => {
    const res = (await handleMemberRoleChangedRequest(
      makeRequest("p1", { username: "bob" }),
      makeEnv("k"),
      async () => {},
    ))!
    expect(res.status).toBe(400)

    const res2 = (await handleMemberRoleChangedRequest(
      makeRequest("p1", { userId: 42 }),
      makeEnv("k"),
      async () => {},
    ))!
    expect(res2.status).toBe(400)
  })

  it("forwards project + user + role to the DO notifier and returns ok", async () => {
    const notified: Array<{ projectId: string; marker: MemberRoleChangedMarker }> = []
    const res = (await handleMemberRoleChangedRequest(
      makeRequest("proj-1", { userId: 42, username: "bob", role: 200 }),
      makeEnv("k"),
      async (_env, projectId, marker) => {
        notified.push({ projectId, marker })
      },
    ))!
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true })
    expect(notified).toEqual([
      { projectId: "proj-1", marker: { userId: 42, username: "bob", role: 200 } },
    ])
  })

  it("still returns 200 when the DO notify fails — the role change must never block on it", async () => {
    const res = (await handleMemberRoleChangedRequest(
      makeRequest("proj-1", { userId: 42, role: 200 }),
      makeEnv("k"),
      async () => {
        throw new Error("DO unavailable")
      },
    ))!
    expect(res.status).toBe(200)
  })
})
