// Test-only reset endpoint for the E2E harness.
//
// POST /__test__/reset — truncates and reseeds enough state that a Playwright
// run can start from a clean baseline. Mirrors the legacy frontier-server's
// `/__test__/reset` route so e2e/helpers/seed.ts works against either backend.
//
// HARD-GATED: 404s unless `WRANGLER_LOCAL=1`. Never deploy this with that
// env set. Production wrangler.toml does NOT define WRANGLER_LOCAL.
//
// Seeds three users (alice, bob, carol) at known passwords so multi-user
// specs can authenticate without going through the registration flow on
// every test. Reseeds idempotently — re-calling /reset is a no-op for any
// state the previous call already produced.

import { Hono } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { hashPasswordWerkzeugScrypt } from "../utils/password"

const testReset = new Hono<AuthHonoEnv>()

interface SeedUser {
  username: "alice" | "bob" | "carol"
  email: string
  password: string
}

const SEED_USERS: SeedUser[] = [
  { username: "alice", email: "alice@example.test", password: "alice-test-pw" },
  { username: "bob", email: "bob@example.test", password: "bob-test-pw" },
  { username: "carol", email: "carol@example.test", password: "carol-test-pw" },
]

testReset.post("/reset", async (c) => {
  if (c.env.WRANGLER_LOCAL !== "1") {
    return c.json({ error: "Not found" }, 404)
  }

  const db = c.env.CODEX_DB
  const codexDb = c.env.CODEX_DB

  // Order matters: drop dependent rows before parents. The hand-rolled
  // delete-everything is safer than a real TRUNCATE because some tables
  // may not exist in older migration states and we want this to no-op
  // gracefully there.
  const tables: Array<{ db: D1Database; name: string }> = [
    { db, name: "project_invites" },
    { db, name: "project_members" },
    { db, name: "org_members" },
    { db, name: "projects" },
    { db, name: "organizations" },
    { db, name: "password_reset_tokens" },
    { db, name: "activity_logs" },
    { db, name: "users" },
  ]
  if (codexDb) {
    tables.unshift({ db: codexDb, name: "cells" })
    tables.unshift({ db: codexDb, name: "files" })
    tables.unshift({ db: codexDb, name: "projects" })
  }

  for (const t of tables) {
    try {
      await t.db.prepare(`DELETE FROM ${t.name}`).run()
    } catch (err) {
      // Table may not exist in this env — log and continue. The reset is
      // best-effort.
      console.warn(`[test-reset] DELETE FROM ${t.name} failed:`, err)
    }
  }

  // Reseed the three known users.
  for (const u of SEED_USERS) {
    const hash = await hashPasswordWerkzeugScrypt(u.password)
    try {
      await db
        .prepare(
          `INSERT INTO users (username, email, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(username) DO UPDATE SET
             email = excluded.email,
             password_hash = excluded.password_hash,
             updated_at = CURRENT_TIMESTAMP`,
        )
        .bind(u.username, u.email, hash)
        .run()
    } catch (err) {
      console.error(`[test-reset] seed insert for ${u.username} failed:`, err)
      return c.json({ error: `seed failed for ${u.username}` }, 500)
    }
  }

  return c.json({ ok: true, seeded: SEED_USERS.map((u) => u.username) })
})

export default testReset
