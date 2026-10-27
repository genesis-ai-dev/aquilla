/**
 * Deep health probe for the uptime monitor (monitor-worker/).
 *
 * `GET /health` (public: `api.aquilla.app/sync/health`) runs one trivial query
 * on Postgres through Hyperdrive and one HEAD on the snapshot R2 bucket. A 200
 * means the Worker, its database path and its blob store all answer; a 503
 * names which dependency failed. The response body says only "ok"/"error" per
 * check — driver messages can carry hostnames (docs/OPSEC.md), so the detail
 * goes to Workers Logs instead.
 */

/** The two dependencies the probe touches. Structural, so tests pass fakes. */
export interface HealthDeps {
  db: { prepare(query: string): { first(): Promise<unknown> } } | undefined
  r2: { head(key: string): Promise<unknown> } | undefined
}

type CheckResult = "ok" | "error"

/** Each check gets this long before it counts as failed. A hung Hyperdrive
 *  connection must not hold the probe open past the monitor's own timeout. */
const CHECK_TIMEOUT_MS = 5_000

/** A key that never exists. HEAD on a missing key is a cheap Class B read that
 *  still proves the bucket answers. */
const R2_PROBE_KEY = "__health-probe"

async function runCheck(name: string, check: () => Promise<unknown>): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS)
      }),
    ])
    return "ok"
  } catch (error) {
    console.error(`[health] ${name} check failed`, error instanceof Error ? error.message : String(error))
    return "error"
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function handleHealthRequest(request: Request, deps: HealthDeps): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  if (new URL(request.url).pathname !== "/health") return null

  const { db, r2 } = deps
  const [postgres, storage] = await Promise.all([
    runCheck("postgres", async () => {
      if (!db) throw new Error("no database handle")
      await db.prepare("SELECT 1").first()
    }),
    runCheck("r2", async () => {
      if (!r2) throw new Error("no SNAPSHOTS binding")
      await r2.head(R2_PROBE_KEY)
    }),
  ])

  const ok = postgres === "ok" && storage === "ok"
  const body = JSON.stringify({ ok, name: "aquilla-sync-worker", checks: { postgres, r2: storage } })
  return new Response(request.method === "HEAD" ? null : body, {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}
