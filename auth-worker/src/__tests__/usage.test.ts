// Contract tests for the usage read endpoints.
//
// Intent: verify that:
//   - GET /api/v1/usage/me returns the caller's own TTS + LLM rollup (today + history).
//     A user who generated audio sees real seconds/requests; a fresh user sees zeros.
//   - GET /api/v1/usage/org/:orgId enforces the maintainer gate (403 for non-managers).
//     A manager sees per-member aggregates and an org total derived from tts + llm tables.
//   - When tts_usage_daily doesn't exist (simulated by dropping it), both /me and
//     /org/:orgId degrade to zeros rather than 500-ing — ensuring the migration can
//     land after the route without service disruption.
//
// These tests mirror the assignment-reads.test.ts harness (PGlite + helpers/db.ts).

import { env } from "cloudflare:test"
import { describe, it, expect, beforeAll } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { pg } from "./helpers/pg-test-env"

// Ensure tts_usage_daily exists even if the migration hasn't been applied to this
// worktree's schema yet. CREATE TABLE IF NOT EXISTS is a no-op when it already exists.
beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS tts_usage_daily (
      user_id       INTEGER          NOT NULL,
      org_id        INTEGER          NOT NULL,
      date_utc      DATE             NOT NULL,
      request_count INTEGER          NOT NULL DEFAULT 0,
      audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, org_id, date_utc)
    )
  `)
})

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedOrgWithMembers() {
  // Org 1: wendi (owner/maintainer 600), anna (contributor 400), outsider (not a member).
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(9, "outsider")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 600, 1), (1, 2, 400, 1)",
  ).run()
  // Project pa in org 1; wendi + anna are project members so they appear in LLM rollup.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 1, 600, 1), ('pa', 2, 400, 1)",
  ).run()
}

async function setOrgFloors(settings: Record<string, unknown>) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 1, 1)",
  )
    .bind(JSON.stringify(settings))
    .run()
}

async function seedTtsRow(userId: number, orgId: number, date: string, seconds: number, requests: number) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO tts_usage_daily (user_id, org_id, date_utc, audio_seconds, request_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, org_id, date_utc) DO UPDATE
       SET audio_seconds  = tts_usage_daily.audio_seconds  + EXCLUDED.audio_seconds,
           request_count  = tts_usage_daily.request_count  + EXCLUDED.request_count`,
  )
    .bind(userId, orgId, date, seconds, requests)
    .run()
}

async function seedLlmRow(userId: number, date: string, requests: number) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO ai_usage_daily (user_id, date_utc, request_count)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id, date_utc) DO UPDATE
       SET request_count = ai_usage_daily.request_count + EXCLUDED.request_count`,
  )
    .bind(userId, date, requests)
    .run()
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── GET /api/v1/usage/me ──────────────────────────────────────────────────────

describe("GET /api/v1/usage/me", () => {
  it("returns 401 without a token", async () => {
    const res = await app.request("/api/v1/usage/me", {}, env)
    expect(res.status).toBe(401)
  })

  it("returns zeros for a user with no usage rows — intent: fresh users get a valid empty shape", async () => {
    await seedUser(1, "wendi")
    const res = await app.request(
      "/api/v1/usage/me",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      today: { audioSeconds: number; ttsRequests: number; llmRequests: number }
      history: unknown[]
    }
    expect(body.today.audioSeconds).toBe(0)
    expect(body.today.ttsRequests).toBe(0)
    expect(body.today.llmRequests).toBe(0)
    expect(Array.isArray(body.history)).toBe(true)
  })

  it("returns correct today totals when the user has TTS + LLM usage — intent: summation must aggregate all rows for the user", async () => {
    await seedUser(1, "wendi")
    await seedUser(2, "anna")
    // Org exists so we can write an org_id into tts_usage_daily.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
    ).run()

    const dt = today()
    // wendi: 30s + 15s TTS in org 1, 5 LLM requests today.
    await seedTtsRow(1, 1, dt, 30, 2)
    await seedTtsRow(1, 1, dt, 15, 1)
    await seedLlmRow(1, dt, 5)
    // anna: 120s TTS — must NOT appear in wendi's rollup.
    await seedTtsRow(2, 1, dt, 120, 10)

    const res = await app.request(
      "/api/v1/usage/me",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      today: { audioSeconds: number; ttsRequests: number; llmRequests: number }
      history: Array<{ date: string; audioSeconds: number; ttsRequests: number; llmRequests: number }>
    }
    // 30 + 15 = 45 seconds; 2 + 1 = 3 TTS requests; 5 LLM requests.
    expect(body.today.audioSeconds).toBe(45)
    expect(body.today.ttsRequests).toBe(3)
    expect(body.today.llmRequests).toBe(5)
    // History must include today's row.
    const todayEntry = body.history.find((h) => h.date === dt)
    expect(todayEntry).toBeDefined()
    expect(todayEntry?.audioSeconds).toBe(45)
    expect(todayEntry?.llmRequests).toBe(5)
  })

  it("degraded TTS (missing table): returns zeros for TTS fields, LLM still works — intent: migration can land after route without downtime", async () => {
    await seedUser(1, "wendi")
    const dt = today()
    await seedLlmRow(1, dt, 7)

    // Drop tts_usage_daily to simulate the migration not yet applied.
    await pg.exec("DROP TABLE IF EXISTS tts_usage_daily")

    const res = await app.request(
      "/api/v1/usage/me",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      today: { audioSeconds: number; ttsRequests: number; llmRequests: number }
    }
    // TTS degrades to zero; LLM still present.
    expect(body.today.audioSeconds).toBe(0)
    expect(body.today.ttsRequests).toBe(0)
    expect(body.today.llmRequests).toBe(7)

    // Recreate the table so teardown/subsequent tests don't break.
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS tts_usage_daily (
        user_id       INTEGER          NOT NULL,
        org_id        INTEGER          NOT NULL,
        date_utc      DATE             NOT NULL,
        request_count INTEGER          NOT NULL DEFAULT 0,
        audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, org_id, date_utc)
      )
    `)
  })
})

// ── GET /api/v1/usage/org/:orgId ─────────────────────────────────────────────

describe("GET /api/v1/usage/org/:orgId", () => {
  it("returns 401 without a token", async () => {
    const res = await app.request("/api/v1/usage/org/1", {}, env)
    expect(res.status).toBe(401)
  })

  it("returns 403 for a contributor (anna) — intent: only managers should see org-wide usage", async () => {
    await seedOrgWithMembers()
    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  // AQU-1771: the org's member-progress and roster floors decide, not a hard
  // Maintainer gate — the Team usage card shows itself from those floors.
  it("lets a contributor read it once the org opens BOTH floors to contributors", async () => {
    await seedOrgWithMembers()
    await setOrgFloors({ memberProgressViewMinRole: 400, rosterViewMinRole: 400 })
    await seedTtsRow(1, 1, today(), 60, 3)
    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(200)
  })

  it("still refuses a contributor when only the progress floor is opened (names are roster data)", async () => {
    await seedOrgWithMembers()
    await setOrgFloors({ memberProgressViewMinRole: 400 })
    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("anna")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("refuses a maintainer once the org raises the progress floor to owners", async () => {
    await seedOrgWithMembers()
    await setOrgFloors({ memberProgressViewMinRole: 700 })
    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  // AQU-1771: people who reach an org project through a direct project grant
  // without belonging to the org are counted in these rows. A manager has
  // always seen them; a contributor the org opened the card to must not.
  it("shows a contributor only the org's own members, a maintainer everyone", async () => {
    await seedOrgWithMembers()
    await seedUser(7, "guest")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 7, 400, 1)",
    ).run()
    await setOrgFloors({ memberProgressViewMinRole: 400, rosterViewMinRole: 400 })
    const dt = today()
    await seedTtsRow(2, 1, dt, 30, 1)
    await seedTtsRow(7, 1, dt, 90, 2)
    await seedLlmRow(7, dt, 5)

    const rows = async (username: string) => {
      const res = await app.request("/api/v1/usage/org/1", { headers: authHeader(await jwtFor(username)) }, env)
      expect(res.status).toBe(200)
      return (await res.json()) as {
        members: Array<{ username: string | null }>
        orgTotal: { audioSeconds: number; llmRequests: number }
      }
    }
    const contributorView = await rows("anna")
    expect(contributorView.members.map((m) => m.username)).toEqual(["anna"])
    expect(contributorView.orgTotal).toMatchObject({ audioSeconds: 30, llmRequests: 0 })

    const managerView = await rows("wendi")
    expect(managerView.members.map((m) => m.username).sort()).toEqual(["anna", "guest"])
  })

  it("returns 403 for a non-member (outsider) — intent: not a member at all means no access", async () => {
    await seedOrgWithMembers()
    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("outsider")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("returns per-member aggregates and org total for a manager — intent: correct summation by user and org", async () => {
    await seedOrgWithMembers()
    const dt = today()

    // wendi (userId=1): 60s TTS (3 requests), 4 LLM.
    await seedTtsRow(1, 1, dt, 60, 3)
    await seedLlmRow(1, dt, 4)
    // anna (userId=2): 120s TTS (5 requests), 0 LLM.
    await seedTtsRow(2, 1, dt, 120, 5)

    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      members: Array<{ userId: number; username: string | null; audioSeconds: number; ttsRequests: number; llmRequests: number }>
      orgTotal: { audioSeconds: number; ttsRequests: number; llmRequests: number }
    }

    const byUser = Object.fromEntries(body.members.map((m) => [m.userId, m]))
    // wendi
    expect(byUser[1]).toMatchObject({ username: "wendi", audioSeconds: 60, ttsRequests: 3, llmRequests: 4 })
    // anna
    expect(byUser[2]).toMatchObject({ username: "anna", audioSeconds: 120, ttsRequests: 5, llmRequests: 0 })

    // Org total = sum across members.
    expect(body.orgTotal.audioSeconds).toBe(180)
    expect(body.orgTotal.ttsRequests).toBe(8)
    expect(body.orgTotal.llmRequests).toBe(4)
  })

  it("excludes rows from other orgs — intent: org_id isolation prevents data leakage between orgs", async () => {
    await seedOrgWithMembers()
    // Org 2 — separate org; anna belongs to it too but wendi does NOT manage it.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Other', 2)",
    ).run()
    const dt = today()
    // anna TTS in org 2 — must NOT appear in org 1 rollup.
    await seedTtsRow(2, 2, dt, 500, 50)
    // anna TTS in org 1 — MUST appear.
    await seedTtsRow(2, 1, dt, 10, 1)

    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      members: Array<{ userId: number; audioSeconds: number }>
    }
    const anna = body.members.find((m) => m.userId === 2)
    // Only org 1 rows: 10s, not 510s.
    expect(anna?.audioSeconds).toBe(10)
  })

  it("degraded TTS (missing table): members still shown with LLM data, TTS zeros — intent: migration can land after route", async () => {
    await seedOrgWithMembers()
    const dt = today()
    await seedLlmRow(1, dt, 9) // wendi LLM

    // Drop tts_usage_daily to simulate missing migration.
    await pg.exec("DROP TABLE IF EXISTS tts_usage_daily")

    const res = await app.request(
      "/api/v1/usage/org/1",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      members: Array<{ userId: number; audioSeconds: number; llmRequests: number }>
      orgTotal: { audioSeconds: number; llmRequests: number }
    }
    const wendi = body.members.find((m) => m.userId === 1)
    expect(wendi?.audioSeconds).toBe(0)
    expect(wendi?.llmRequests).toBe(9)
    expect(body.orgTotal.audioSeconds).toBe(0)
    expect(body.orgTotal.llmRequests).toBe(9)

    // Recreate the table so teardown/subsequent tests don't break.
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS tts_usage_daily (
        user_id       INTEGER          NOT NULL,
        org_id        INTEGER          NOT NULL,
        date_utc      DATE             NOT NULL,
        request_count INTEGER          NOT NULL DEFAULT 0,
        audio_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, org_id, date_utc)
      )
    `)
  })
})
