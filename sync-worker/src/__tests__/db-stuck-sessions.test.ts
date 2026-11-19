// AQU-2611 — GET /admin/db/stuck-sessions, the signal monitor-worker alerts on.
//
// What is pinned here is the contract the monitor depends on: the auth gate
// fails closed, the aggregate counts only our driver's sessions while still
// reporting the unfiltered total (so a dropped application_name cannot turn the
// alert into a silent no-op), and counts arrive as numbers even when the driver
// hands int8 back as a string.
import { describe, it, expect } from "vitest"
import { handleDbStuckSessionsRequest } from "../db-stuck-sessions-route"

const URL_BASE = "https://sync.example/admin/db/stuck-sessions"
const AUTHED = { Authorization: "Bearer s3cret" }

/** Records the statement + bindings and returns one scripted aggregate row. */
function probeDb(row: unknown) {
  const seen: { sql: string; params: unknown[] } = { sql: "", params: [] }
  const db = {
    prepare(sql: string) {
      seen.sql = sql
      const statement = {
        bind: (...params: unknown[]) => {
          seen.params = params
          return statement
        },
        first: async () => row,
        all: async () => ({ results: [], success: true as const }),
        run: async () => ({ results: [], success: true as const }),
        raw: async () => [],
      }
      return statement
    },
  } as unknown as AquillaDb
  return { db, seen }
}

const envWith = (row: unknown) => {
  const { db, seen } = probeDb(row)
  return { env: { AQUILLA_PG: db, ADMIN_SECRET: "s3cret" }, seen }
}

const HEALTHY = { n: 0, backends_any_application: 0, observable_backends: 12, sample_query: null }

describe("GET /admin/db/stuck-sessions", () => {
  it("falls through for any other path", async () => {
    const { env } = envWith(HEALTHY)
    expect(await handleDbStuckSessionsRequest(new Request("https://sync.example/other"), env))
      .toBeNull()
  })

  it("401s without the admin bearer", async () => {
    const { env } = envWith(HEALTHY)
    expect((await handleDbStuckSessionsRequest(new Request(URL_BASE), env))?.status).toBe(401)
  })

  it("500s when no admin credential is bound (fails closed)", async () => {
    const { db } = probeDb(HEALTHY)
    const res = await handleDbStuckSessionsRequest(
      new Request(URL_BASE, { headers: AUTHED }),
      { AQUILLA_PG: db },
    )
    expect(res?.status).toBe(500)
  })

  it("405s a non-GET", async () => {
    const { env } = envWith(HEALTHY)
    const res = await handleDbStuckSessionsRequest(
      new Request(URL_BASE, { method: "POST", headers: AUTHED }),
      env,
    )
    expect(res?.status).toBe(405)
  })

  it("reports zero on a healthy database", async () => {
    const { env } = envWith(HEALTHY)
    const res = await handleDbStuckSessionsRequest(new Request(URL_BASE, { headers: AUTHED }), env)
    expect(res?.status).toBe(200)
    expect(await res!.json()).toEqual({
      ok: true,
      n: 0,
      backendsAnyApplication: 0,
      observableBackends: 12,
      sampleQuery: null,
      minAgeSeconds: 30,
    })
  })

  it("reports the count and the stuck statement's leading text", async () => {
    const { env } = envWith({
      n: 55,
      backends_any_application: 55,
      observable_backends: 60,
      sample_query: "select id, name from organization_settings where org_id = $1",
    })
    const res = await handleDbStuckSessionsRequest(new Request(URL_BASE, { headers: AUTHED }), env)
    expect(await res!.json()).toMatchObject({
      n: 55,
      sampleQuery: "select id, name from organization_settings where org_id = $1",
    })
  })

  it("coerces int8 counts handed back as strings", async () => {
    const { env } = envWith({
      n: "7",
      backends_any_application: "9",
      observable_backends: "41",
      sample_query: "select 1",
    })
    const res = await handleDbStuckSessionsRequest(new Request(URL_BASE, { headers: AUTHED }), env)
    expect(await res!.json()).toMatchObject({ n: 7, backendsAnyApplication: 9, observableBackends: 41 })
  })

  it("keeps the unfiltered total, so a dropped application_name is visible", async () => {
    // n === 0 beside a nonzero total is the no-op this field exists to name.
    const { env } = envWith({
      n: 0,
      backends_any_application: 40,
      observable_backends: 60,
      sample_query: null,
    })
    const res = await handleDbStuckSessionsRequest(new Request(URL_BASE, { headers: AUTHED }), env)
    expect(await res!.json()).toMatchObject({ n: 0, backendsAnyApplication: 40 })
  })

  it("reports how many other sessions' state this role can read", async () => {
    // Zero here on a busy database means pg_stat_activity is hiding state from
    // this role, so the predicate can never match whatever the pool is doing.
    const { env } = envWith({
      n: 0,
      backends_any_application: 0,
      observable_backends: 0,
      sample_query: null,
    })
    const res = await handleDbStuckSessionsRequest(new Request(URL_BASE, { headers: AUTHED }), env)
    expect(await res!.json()).toMatchObject({ observableBackends: 0 })
  })

  it("filters on our driver, excludes its own backend, and binds the age window", async () => {
    const { env, seen } = envWith(HEALTHY)
    await handleDbStuckSessionsRequest(new Request(URL_BASE, { headers: AUTHED }), env)
    expect(seen.sql).toContain("wait_event = 'ClientRead'")
    expect(seen.sql).toContain("state = 'active'")
    expect(seen.sql).toContain("pid <> pg_backend_pid()")
    expect(seen.sql).toContain("state IS NOT NULL")
    expect(seen.params).toEqual([30, "postgres.js"])
  })

  it("accepts a custom age window and rejects a nonsense one", async () => {
    const { env, seen } = envWith(HEALTHY)
    const ok = await handleDbStuckSessionsRequest(
      new Request(`${URL_BASE}?minAgeSeconds=120`, { headers: AUTHED }),
      env,
    )
    expect(ok?.status).toBe(200)
    expect(seen.params[0]).toBe(120)
    for (const q of ["0", "-1", "1.5", "abc", "3601"]) {
      const res = await handleDbStuckSessionsRequest(
        new Request(`${URL_BASE}?minAgeSeconds=${q}`, { headers: AUTHED }),
        env,
      )
      expect(res?.status, q).toBe(400)
    }
  })
})
