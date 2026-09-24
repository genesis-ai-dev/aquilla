// AQU-730 slice 0 — PRE-grant-inversion characterization baseline for
// signSyncTokenWithRole (sync-token-mint.ts).
//
// These tests pin TODAY'S behavior: project_member_scopes rows become a
// `scopes` JWT claim; when there are NO rows the claim is OMITTED entirely
// (absent = unscoped = all lanes on the sync-worker). When grant-based
// enforcement lands, mint will emit lane grants instead — update this file
// deliberately; do not delete silently.
//
// See: docs/superpowers/specs/2026-09-10-lane-permissions-and-read-wall-design.md §0, §4.

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
    "INSERT INTO projects (id, name, created_by) VALUES ('p1', 'Baseline', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p1', 1, 400)",
  ).run()
}

describe("AQU-730 baseline — signSyncTokenWithRole scopes claim", () => {
  it("OMITS the scopes claim when project_member_scopes has no rows", async () => {
    await seedProjectMember()
    const signed = await signSyncTokenWithRole(
      env as unknown as Env,
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 400, name: "contributor", source: "override" },
    )
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as Record<string, unknown>
    expect(claims.scopes).toBeUndefined()
    expect(Object.hasOwn(claims, "scopes")).toBe(false)
  })

  it("INCLUDES sorted [{kind,value}] scopes when rows exist", async () => {
    await seedProjectMember()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_at)
       VALUES ('p1', 1, 'lane', 'pt', 0),
              ('p1', 1, 'lane', 'es', 0),
              ('p1', 1, 'file', 'f-9', 0)`,
    ).run()
    const signed = await signSyncTokenWithRole(
      env as unknown as Env,
      { id: 1, username: "alice" },
      "p1",
      "file-a",
      { level: 400, name: "contributor", source: "override" },
    )
    const claims = (await verify(signed.token, SYNC_SECRET, "HS256")) as {
      scopes?: { kind: string; value: string }[]
    }
    // ORDER BY kind, value in signSyncTokenWithRole
    expect(claims.scopes).toEqual([
      { kind: "file", value: "f-9" },
      { kind: "lane", value: "es" },
      { kind: "lane", value: "pt" },
    ])
  })
})
