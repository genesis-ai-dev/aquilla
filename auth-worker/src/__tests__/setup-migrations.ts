import { env, applyD1Migrations } from "cloudflare:test"
import { beforeAll, afterEach } from "vitest"

beforeAll(async () => {
  await applyD1Migrations(env.AQUILLA_DB, env.TEST_MIGRATIONS)
})

// Truncate application tables between tests so each test starts clean.
// The schema (CREATE TABLE, indexes) is preserved — only row data is cleared.
afterEach(async () => {
  await env.AQUILLA_DB.prepare("DELETE FROM project_invites").run()
  await env.AQUILLA_DB.prepare("DELETE FROM project_members").run()
  await env.AQUILLA_DB.prepare("DELETE FROM group_project_grants").run()
  await env.AQUILLA_DB.prepare("DELETE FROM group_members").run()
  await env.AQUILLA_DB.prepare("DELETE FROM groups").run()
  await env.AQUILLA_DB.prepare("DELETE FROM org_members").run()
  await env.AQUILLA_DB.prepare("DELETE FROM projects").run()
  await env.AQUILLA_DB.prepare("DELETE FROM password_reset_tokens").run()
  await env.AQUILLA_DB.prepare("DELETE FROM activity_logs").run()
  await env.AQUILLA_DB.prepare("DELETE FROM organizations").run()
  await env.AQUILLA_DB.prepare("DELETE FROM users").run()
})
