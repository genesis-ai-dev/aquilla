// AQU-730 slice 2 — dual-read mint of the `laneGrants` claim from
// project_member_lane_roles. The claim is omitted when empty (no-op until
// the deferred backfill populates the table). Scopes stay on their own table.
//
// AQU-1389 — that read is now gated by services/lane-grants.ts and is OFF by
// default, so the lane-model cutover carries no dependency on the permission
// table. These tests pin both halves: flag off issues no query and omits the
// claim even when grant rows exist; flag on preserves the original dual-read
// behavior verbatim.
//
// See: docs/superpowers/specs/2026-09-10-lane-permissions-and-read-wall-design.md §4.2

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { verify } from "hono/jwt"
import { signSyncTokenWithRole } from "../services/sync-token-mint"
import { LaneGrantLookupError, loadLaneGrants } from "../services/lane-grants"
import type { Env } from "../types"
import { seedUser } from "./helpers/db"

const SYNC_SECRET = "sync-secret"

/** Env with the AQU-1352 lane-grant rollout gate ON. */
function envWithGrantsEnabled(): Env {
  return { ...(env as unknown as Env), LANE_GRANTS_ENABLED: "true" }
}

async function seedProjectMember(): Promise<void> {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES ('p1', 'P', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 1, 400)",
  ).run()
}

async function seedGrants(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level)
     VALUES ('p1', 1, 'fr', 300), ('p1', 1, 'es', 400)`,
  ).run()
}

describe("AQU-730 — signSyncTokenWithRole laneGrants claim", () => {
  it("OMITS laneGrants when project_member_lane_roles has no rows; scopes still omitted when empty", async () => {
    await seedProjectMember()
    const signed = await signSyncTokenWithRole(
      envWithGrantsEnabled(),
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

  it("INCLUDES laneGrants sorted by lane when rows exist AND the rollout flag is on", async () => {
    await seedProjectMember()
    await seedGrants()
    const signed = await signSyncTokenWithRole(
      envWithGrantsEnabled(),
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 400, name: "contributor", source: "override" },
    )
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as {
      laneGrants?: { lane: string; level: number }[]
    }
    expect(claims.laneGrants).toEqual([
      { lane: "es", level: 400 },
      { lane: "fr", level: 300 },
    ])
  })
})

describe("AQU-1389 — the lane-model rollout carries no lane-grant dependency", () => {
  it("omits laneGrants with the flag OFF even when grant rows exist", async () => {
    await seedProjectMember()
    await seedGrants()
    const signed = await signSyncTokenWithRole(
      env as unknown as Env, // LANE_GRANTS_ENABLED unset — the deployed default
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 400, name: "contributor", source: "override" },
    )
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as Record<string, unknown>
    expect(Object.hasOwn(claims, "laneGrants")).toBe(false)
    // The base role — the thing that actually gates access today — is intact.
    expect(claims.role).toBe(400)
  })

  it("mints successfully with the flag OFF even if the grant table is unreadable", async () => {
    // Stands in for a database where migration 0091 has not been applied (or
    // where AQU-1352 has since replaced the table). An unconditional read
    // would throw here and take every mint — and therefore every read, edit
    // and assignment — down with it.
    let laneTableQueried = false
    const brokenPg = {
      prepare(sql: string) {
        if (sql.includes("project_member_lane_roles")) {
          laneTableQueried = true
          throw new Error('relation "project_member_lane_roles" does not exist')
        }
        return env.AQUILLA_PG.prepare(sql)
      },
    }
    const signed = await signSyncTokenWithRole(
      { AQUILLA_PG: brokenPg, SYNC_SECRET_KEY: SYNC_SECRET } as unknown as Env,
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 400, name: "contributor", source: "override" },
    )
    expect(laneTableQueried).toBe(false)
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as Record<string, unknown>
    expect(claims.role).toBe(400)
    expect(Object.hasOwn(claims, "laneGrants")).toBe(false)
  })

  it("surfaces a failed grant read as LaneGrantLookupError when the flag is ON (never fails open)", async () => {
    const brokenPg = {
      prepare() {
        throw new Error("db blip")
      },
    }
    await expect(
      loadLaneGrants(
        { AQUILLA_PG: brokenPg, LANE_GRANTS_ENABLED: "true" } as unknown as Env,
        "p1",
        1,
      ),
    ).rejects.toBeInstanceOf(LaneGrantLookupError)
  })

  it("treats any value other than the exact string \"true\" as off", async () => {
    const brokenPg = {
      prepare() {
        throw new Error("must not be called")
      },
    }
    for (const value of [undefined, "", "false", "1", "TRUE "]) {
      await expect(
        loadLaneGrants(
          { AQUILLA_PG: brokenPg, LANE_GRANTS_ENABLED: value } as unknown as Env,
          "p1",
          1,
        ),
      ).resolves.toEqual([])
    }
  })
})
