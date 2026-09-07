// Perf (2026-09): two writes that used to ride the request path.
//  - revoked_tokens pruning ran as a random 2%-of-logouts DELETE; it now runs
//    from the 5-minute cron and never from revokeToken.
//  - bumpOrgActivity issued an UPDATE on every call; the "5 minute debounce"
//    was only a WHERE clause. The statement itself is now skipped when this
//    isolate bumped the pair inside the window.
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { pruneExpiredRevokedTokens, revokeToken } from "../utils/token-revocation"
import { bumpOrgActivity, ORG_ACTIVITY_DEBOUNCE_MS } from "../services/org-permissions"
import { seedUser } from "./helpers/db"

function countingDb(): { db: typeof env.AQUILLA_PG; sql: string[] } {
  const sql: string[] = []
  const real = env.AQUILLA_PG
  const db = {
    prepare: (text: string) => {
      sql.push(text)
      return real.prepare(text)
    },
  } as unknown as typeof env.AQUILLA_PG
  return { db, sql }
}

afterEach(() => vi.useRealTimers())

describe("revoked_tokens pruning", () => {
  it("revokeToken never issues the prune DELETE", async () => {
    await seedUser(1, "prune-user")
    const { db, sql } = countingDb()
    const random = vi.spyOn(Math, "random").mockReturnValue(0) // would have pruned before
    try {
      await revokeToken(db, "jti-a", 1, Math.floor(Date.now() / 1000) + 3600)
    } finally {
      random.mockRestore()
    }
    expect(sql.some((s) => s.includes("DELETE FROM revoked_tokens"))).toBe(false)
  })

  it("pruneExpiredRevokedTokens removes only expired rows", async () => {
    await seedUser(1, "prune-user")
    const now = Math.floor(Date.now() / 1000)
    await revokeToken(env.AQUILLA_PG, "jti-expired", 1, now - 60)
    await revokeToken(env.AQUILLA_PG, "jti-live", 1, now + 3600)
    await pruneExpiredRevokedTokens(env.AQUILLA_PG)
    const rows = await env.AQUILLA_PG.prepare("SELECT jti FROM revoked_tokens ORDER BY jti").all<{ jti: string }>()
    expect(rows.results.map((r) => r.jti)).toEqual(["jti-live"])
  })
})

describe("bumpOrgActivity debounce", () => {
  async function seedOrgMember(): Promise<void> {
    await seedUser(1, "bump-user")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'O', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level) VALUES (1, 1, 400)",
    ).run()
  }
  const updates = (sql: string[]): number => sql.filter((s) => s.includes("UPDATE org_members")).length

  it("issues the UPDATE once per (org, user) inside the window, again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    await seedOrgMember()
    const { db, sql } = countingDb()
    const reqEnv = { ...env, AQUILLA_PG: db }

    await bumpOrgActivity(reqEnv, 1, 1)
    await bumpOrgActivity(reqEnv, 1, 1)
    expect(updates(sql)).toBe(1)
    const row = await env.AQUILLA_PG.prepare(
      "SELECT last_active_at FROM org_members WHERE org_id = 1 AND user_id = 1",
    ).first<{ last_active_at: string | null }>()
    expect(row?.last_active_at).not.toBeNull()

    vi.advanceTimersByTime(ORG_ACTIVITY_DEBOUNCE_MS)
    await bumpOrgActivity(reqEnv, 1, 1)
    expect(updates(sql)).toBe(2)
  })

  it("debounces per pair, not globally", async () => {
    await seedOrgMember()
    const { db, sql } = countingDb()
    const reqEnv = { ...env, AQUILLA_PG: db }
    await bumpOrgActivity(reqEnv, 1, 1)
    await bumpOrgActivity(reqEnv, 1, 2)
    expect(updates(sql)).toBe(2)
  })
})
