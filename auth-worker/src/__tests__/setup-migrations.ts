// Test DB lifecycle. Loads the canonical Postgres schema into the per-file
// PGlite once, then truncates every table between tests so each starts clean.
// (Replaces the old D1-migrations + sqlite_master topological-DELETE dance —
// Postgres TRUNCATE ... RESTART IDENTITY CASCADE handles FK order for us.)
import { beforeAll, afterEach } from "vitest"
import { initTestSchema, resetTestDb } from "./helpers/pg-test-env"
import { clearSessionCache } from "../lib/session-cache"
import { clearOrgActivityDebounce } from "../services/org-permissions"

beforeAll(async () => {
  await initTestSchema()
})

afterEach(async () => {
  await resetTestDb()
  // Isolate-memory caches would otherwise outlive the truncated rows.
  clearSessionCache()
  clearOrgActivityDebounce()
})
