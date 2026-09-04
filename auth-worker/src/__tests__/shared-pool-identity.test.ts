// The Postgres handle is now ONE isolate-shared pool reused across requests
// (db/shim/postgres.ts getPostgres). Identity threading relies on `SET LOCAL`
// being transaction-scoped: request A's `withUser(42)` must never be visible
// to request B, which runs bare (or as another user) on the very same handle
// and possibly the very same connection. This test drives two sequential
// "requests" through one shared PostgresDb and reads the GUC back each time.
import { describe, it, expect } from "vitest"
import { env } from "./helpers/pg-test-env"
import type { PostgresDb } from "../../../db/shim/postgres"

const shared = env.AQUILLA_PG as unknown as PostgresDb

const readIdentity = async (db: PostgresDb) =>
  db.prepare("SELECT current_setting('app.user_id', true) AS uid").first<{ uid: string | null }>()

describe("shared pool: identity does not leak between sequential requests", () => {
  it("request 1 as user 42, request 2 bare on the same handle sees no identity", async () => {
    // Request 1 — authenticated path.
    const r1 = await readIdentity(shared.withUser(42))
    expect(r1?.uid).toBe("42")
    // Request 2 — bare handle, same pool. PGlite runs a single connection, so
    // this is the worst case: the exact socket request 1 used.
    const r2 = await readIdentity(shared)
    expect(r2?.uid ?? "").toBe("")
  })

  it("user → admin → other user on one handle each see only their own identity", async () => {
    expect((await readIdentity(shared.withUser(7)))?.uid).toBe("7")
    expect((await readIdentity(shared.asAdmin()))?.uid).toBe("")
    expect((await readIdentity(shared.withUser(9)))?.uid).toBe("9")
    expect((await readIdentity(shared))?.uid ?? "").toBe("")
  })

  it("identity set inside a transaction() is gone once it commits", async () => {
    await shared.withUser(5).transaction(async (tx) => {
      expect((await readIdentity(tx as PostgresDb))?.uid).toBe("5")
    })
    expect((await readIdentity(shared))?.uid ?? "").toBe("")
  })
})
