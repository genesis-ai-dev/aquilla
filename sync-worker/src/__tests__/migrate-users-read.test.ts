// GET /migrate/users — id/username/email for client-side GitLab-member→aquilla
// resolution during group import (replaces the old `wrangler d1` users read).
import { describe, it, expect, afterAll } from "vitest"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { handleMigrateUsersReadRequest } from "../events/migrate-users-read-route"

const SECRET = "users-secret"
const req = (auth = `Bearer ${SECRET}`) =>
  new Request("https://sync.example/migrate/users", { headers: { Authorization: auth } })

let t: TestDb
afterAll(async () => {
  await t?.close()
})

describe("handleMigrateUsersReadRequest", () => {
  it("returns id/username/email for all users", async () => {
    t = await makeTestDb({
      users: [
        { id: 1, username: "alice", email: "alice@x.io" },
        { id: 2, username: "bob", email: "bob@x.io" },
      ],
    })
    const res = await handleMigrateUsersReadRequest(req(), { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { users: { id: number; username: string; email: string }[] }
    expect(body.users).toContainEqual({ id: 1, username: "alice", email: "alice@x.io" })
    expect(body.users).toHaveLength(2)
  })

  it("rejects wrong secret + ignores other paths", async () => {
    expect((await handleMigrateUsersReadRequest(req("Bearer no"), { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }))?.status).toBe(401)
    expect(
      await handleMigrateUsersReadRequest(new Request("https://sync.example/x"), { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }),
    ).toBeNull()
  })
})
