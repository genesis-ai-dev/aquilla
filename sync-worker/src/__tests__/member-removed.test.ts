// AQU-346: POST /admin/projects/:projectId/member-removed — identity calls
// this after deleting a project_members row so the live ProjectSync DO can
// eject the removed user's sockets and denylist their still-valid tokens.
//
// WHY: without this hook, an ejected user's WebSocket session (authorized
// once at connect) lives forever, and their ≤15-min token can reconnect.
// The route itself must be best-effort: a DO failure logs but returns 200 —
// identity's removal must never fail on the eject acceleration.

import { describe, it, expect } from "vitest"
import {
  handleMemberRemovedRequest,
  type MemberRemovedEnv,
  type MemberRemovedMarker,
} from "../member-removed"

function makeEnv(secret = "shared-secret"): MemberRemovedEnv {
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
  return new Request(`https://worker/admin/projects/${projectId}/member-removed`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  })
}

describe("POST /admin/projects/:projectId/member-removed", () => {
  it("requires a matching Authorization header", async () => {
    const res = (await handleMemberRemovedRequest(
      makeRequest("p1", { userId: 2 }, "Bearer wrong"),
      makeEnv("k"),
      async () => {},
    ))!
    expect(res.status).toBe(401)
  })

  it("rejects non-POST methods", async () => {
    const res = (await handleMemberRemovedRequest(
      makeRequest("p1", undefined, "Bearer k", "GET"),
      makeEnv("k"),
      async () => {},
    ))!
    expect(res.status).toBe(405)
  })

  it("returns null for non-matching paths so the caller can fall through", async () => {
    const res = await handleMemberRemovedRequest(
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

  it("rejects a body without a numeric userId", async () => {
    const res = (await handleMemberRemovedRequest(
      makeRequest("p1", { username: "bob" }),
      makeEnv("k"),
      async () => {},
    ))!
    expect(res.status).toBe(400)
  })

  it("forwards project + user to the DO notifier and returns ok", async () => {
    const notified: Array<{ projectId: string; marker: MemberRemovedMarker }> = []
    const res = (await handleMemberRemovedRequest(
      makeRequest("proj-1", { userId: 42, username: "bob" }),
      makeEnv("k"),
      async (_env, projectId, marker) => {
        notified.push({ projectId, marker })
      },
    ))!
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true })
    expect(notified).toEqual([
      { projectId: "proj-1", marker: { userId: 42, username: "bob" } },
    ])
  })

  it("still returns 200 when the DO notify fails — removal must never block on the eject", async () => {
    const res = (await handleMemberRemovedRequest(
      makeRequest("proj-1", { userId: 42 }),
      makeEnv("k"),
      async () => {
        throw new Error("DO unavailable")
      },
    ))!
    expect(res.status).toBe(200)
  })
})
