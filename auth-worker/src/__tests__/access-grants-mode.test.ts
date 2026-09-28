/**
 * AQU-1352 P1 — ACCESS_GRANTS_RESOLVER flag safety (spec §5 P1: "one
 * resolver, behavior-preserving, flagged").
 *
 * Why these cases matter:
 *   - shadow must never change an answer, only report drift, or turning it on
 *     in dev would itself be a behavior change;
 *   - an env where migration 0130 has not applied (no access_grants view) must
 *     keep answering exactly as today in every mode, or deploying the code
 *     before the migration would lock people out.
 */

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FIXTURE_USERS, seedAccessFixture } from "./helpers/access-fixture"
import { resolveProjectRole } from "../services/project-permissions"
import {
  parseAccessGrantsMode,
  resolveProjectRoleShared,
  type AccessGrantsMode,
} from "../../../db/shared/project-roles"
import type { AuthUser, Env } from "../types"

const TEAM_ONLY = FIXTURE_USERS.team_only

async function loadUser(id: number): Promise<AuthUser> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT id, username, email, password_hash, preferences, created_at, updated_at,
            password_changed_at FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<AuthUser>()
  if (!row) throw new Error("fixture user missing")
  return row
}

function envFor(mode: AccessGrantsMode): Env {
  return { ...(env as unknown as Env), ACCESS_GRANTS_RESOLVER: mode }
}

function parityLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c: unknown[]) => c[0])
    .filter((m: unknown): m is string => typeof m === "string" && m.includes("access_grants_parity_mismatch"))
    .map((m: string) => JSON.parse(m) as Record<string, unknown>)
}

async function exec(sql: string): Promise<void> {
  await env.AQUILLA_PG.prepare(sql).run()
}

// Swap the real view for an empty stand-in (forced discrepancy), or remove it
// (un-migrated env). afterEach restores the real view.
async function hideView(replaceWithEmpty: boolean): Promise<void> {
  await exec(`ALTER VIEW access_grants RENAME TO access_grants_real`)
  if (replaceWithEmpty) {
    await exec(`CREATE VIEW access_grants AS SELECT * FROM access_grants_real WHERE false`)
  }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  await seedAccessFixture()
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  warn.mockRestore()
  const hidden = await env.AQUILLA_PG.prepare(
    `SELECT 1 AS x FROM pg_views WHERE viewname = 'access_grants_real'`,
  ).first<{ x: number }>()
  if (hidden) {
    await exec(`DROP VIEW IF EXISTS access_grants`)
    await exec(`ALTER VIEW access_grants_real RENAME TO access_grants`)
  }
})

describe("AQU-1352 ACCESS_GRANTS_RESOLVER parsing", () => {
  it("defaults to off for unset or unknown values so a typo cannot flip production", () => {
    expect(parseAccessGrantsMode(undefined)).toBe("off")
    expect(parseAccessGrantsMode("")).toBe("off")
    expect(parseAccessGrantsMode("ON")).toBe("off")
    expect(parseAccessGrantsMode("shadow")).toBe("shadow")
    expect(parseAccessGrantsMode("on")).toBe("on")
  })
})

describe("AQU-1352 shadow mode", () => {
  it("returns today's answer and logs nothing when the view agrees", async () => {
    const role = await resolveProjectRole(envFor("shadow"), await loadUser(TEAM_ONLY), "p1")
    expect(role).toEqual({ level: 400, name: "contributor", source: "group" })
    expect(parityLines(warn)).toEqual([])
  })

  it("auth-worker: returns today's answer and logs one structured mismatch when the view disagrees", async () => {
    await hideView(true)
    const role = await resolveProjectRole(envFor("shadow"), await loadUser(TEAM_ONLY), "p1")
    expect(role).toEqual({ level: 400, name: "contributor", source: "group" })
    expect(parityLines(warn)).toEqual([
      {
        event: "access_grants_parity_mismatch",
        userId: String(TEAM_ONLY),
        projectId: "p1",
        legacy: { level: 400, source: "group" },
        grants: null,
      },
    ])
  })

  it("shared (Agent API): same shadow contract", async () => {
    await hideView(true)
    const role = await resolveProjectRoleShared(env.AQUILLA_PG, { id: String(TEAM_ONLY) }, "p1", undefined, "shadow")
    expect(role).toEqual({ level: 400, source: "group" })
    expect(parityLines(warn)).toHaveLength(1)
  })
})

describe("AQU-1352 missing access_grants view (migration 0130 not applied)", () => {
  it.each(["shadow", "on"] as const)("auth-worker %s falls back to today's resolver", async (mode) => {
    await hideView(false)
    const role = await resolveProjectRole(envFor(mode), await loadUser(TEAM_ONLY), "p1")
    expect(role).toEqual({ level: 400, name: "contributor", source: "group" })
  })

  it.each(["shadow", "on"] as const)("shared %s falls back to today's resolver", async (mode) => {
    await hideView(false)
    const role = await resolveProjectRoleShared(env.AQUILLA_PG, { id: String(TEAM_ONLY) }, "p1", undefined, mode)
    expect(role).toEqual({ level: 400, source: "group" })
  })

  it("on mode trusts the view when it answers (empty view denies — proves 'on' really reads it)", async () => {
    await hideView(true)
    const role = await resolveProjectRole(envFor("on"), await loadUser(TEAM_ONLY), "p1")
    expect(role).toBeNull()
  })
})
