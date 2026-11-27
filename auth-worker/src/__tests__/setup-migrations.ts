// Test DB lifecycle. The per-file PGlite arrives with the canonical Postgres
// schema already in it (a copy of the run's template); this readies its
// session once, then empties the tables between tests so each starts clean.
// (Replaces the old D1-migrations + sqlite_master topological-DELETE dance —
// Postgres TRUNCATE ... RESTART IDENTITY CASCADE handles FK order for us.)
import { beforeAll, afterEach } from "vitest"
import { initTestSchema, resetTestDb } from "./helpers/pg-test-env"
import { clearSessionCache } from "../lib/session-cache"
import { clearContextualReadCache } from "../lib/contextual/read-cache"
import { clearOrgActivityDebounce } from "../services/org-permissions"

beforeAll(async () => {
  await initTestSchema()
})

afterEach(async () => {
  await resetTestDb()
  // Isolate-memory caches would otherwise outlive the truncated rows.
  clearSessionCache()
  clearContextualReadCache()
  clearOrgActivityDebounce()
})
