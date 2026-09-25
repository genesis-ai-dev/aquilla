// AQU-730 slice 2 — dual-read mint of the `laneGrants` claim from
// project_member_lane_roles. The claim is omitted when empty (no-op until
// the deferred backfill populates the table). Scopes stay on their own table.
//
// See: docs/superpowers/specs/2026-09-10-lane-permissions-and-read-wall-design.md §4.2

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { verify } from "hono/jwt"
import { signSyncTokenWithRole } from "../services/sync-token-mint"
import type { Env } from "../types"
import { seedUser } from "./helpers/db"

const SYNC_SECRET = "sync-secret"

async function seedProjectMember(): Promise<void> {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 1, 400)",
  ).run()
}

describe("AQU-730 — signSyncTokenWithRole laneGrants claim", () => {
  it("OMITS laneGrants when project_member_lane_roles has no rows; scopes still omitted when empty", async () => {
    await seedProjectMember()
    const signed = await signSyncTokenWithRole(
      env as unknown as Env,
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 400, name: "contributor", source: "override" },
    )
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as Record<string, unknown>
    expect(claims.laneGrants).toBeUndefined()
    expect(Object.hasOwn(claims, "laneGrants")).toBe(false)
    expect(claims.scopes).toBeUndefined()
    expect(Object.hasOwn(claims, "scopes")).toBe(false)
  })

  it("INCLUDES laneGrants sorted by lane when rows exist", async () => {
    await seedProjectMember()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level)
       VALUES ('p1', 1, 'lanefr01', 300), ('p1', 1, 'lanees01', 400)`,
    ).run()
    const signed = await signSyncTokenWithRole(
      env as unknown as Env,
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 400, name: "contributor", source: "override" },
    )
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as {
      laneGrants?: { lane: string; level: number }[]
    }
    expect(claims.laneGrants).toEqual([
      { lane: "lanees01", level: 400 },
      { lane: "lanefr01", level: 300 },
    ])
  })
})
