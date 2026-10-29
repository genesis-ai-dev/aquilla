import { afterEach, describe, expect, it, vi } from "vitest"
import { handleHealthRequest, type HealthDeps } from "../health-route"

// monitor-worker/ polls https://api.aquilla.app/sync/health every minute and
// pages the team when it fails, so the probe must fail when a dependency does —
// and must not leak driver messages, which can carry hostnames.
describe("handleHealthRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const healthyDb = { prepare: () => ({ first: async () => ({ "?column?": 1 }) }) }
  const healthyR2 = { head: async () => null }
  const get = (deps: HealthDeps, path = "/health", method = "GET") =>
    handleHealthRequest(new Request(`https://api.aquilla.app${path}`, { method }), deps)

  it("answers 200 when Postgres and R2 both answer", async () => {
    const res = await get({ db: healthyDb, r2: healthyR2 })
    expect(res?.status).toBe(200)
    expect(await res!.json()).toEqual({
      ok: true,
      name: "aquilla-sync-worker",
      checks: { postgres: "ok", r2: "ok" },
    })
  })

  it("answers 503 and names Postgres when the query throws, without the driver message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const db = {
      prepare: () => ({
        first: async () => {
          throw new Error("connect ECONNREFUSED secret-host.neon.tech:5432")
        },
      }),
    }
    const res = await get({ db, r2: healthyR2 })
    expect(res?.status).toBe(503)
    const text = await res!.text()
    expect(JSON.parse(text).checks).toEqual({ postgres: "error", r2: "ok" })
    expect(text).not.toContain("neon.tech")
  })

  it("answers 503 when R2 fails or a binding is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r2 = {
      head: async () => {
        throw new Error("R2 down")
      },
    }
    expect((await get({ db: healthyDb, r2 }))?.status).toBe(503)
    expect((await get({ db: undefined, r2: healthyR2 }))?.status).toBe(503)
  })

  it("fails a check that hangs instead of holding the probe open", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const db = { prepare: () => ({ first: () => new Promise<never>(() => {}) }) }
    const pending = get({ db, r2: healthyR2 })
    await vi.advanceTimersByTimeAsync(5_000)
    const res = await pending
    expect(res?.status).toBe(503)
    expect(((await res!.json()) as { checks: { postgres: string } }).checks.postgres).toBe("error")
  })

  it("leaves every other path and method to the router", async () => {
    expect(await get({ db: healthyDb, r2: healthyR2 }, "/healthz")).toBeNull()
    expect(await get({ db: healthyDb, r2: healthyR2 }, "/health", "POST")).toBeNull()
  })
})
