import { describe, it, expect } from "vitest"
import { createApp, TENANT_HEADER } from "../src/app"
import type { Env } from "../src/types"
import type { SandboxLike, SandboxReadResult, SandboxRunResult, SandboxWriteResult } from "../src/sandbox"
import { makeFakePool, noSleep } from "./fake-pool"

// ---------------------------------------------------------------------------
// AQU-1848 — the routes that may START a container must take a pool lease
// first, and DELETE must give it back. Without the lease the 21st concurrent
// run simply failed at container-start; without the release the pool would
// leak a slot per finished run.
//
// The pool gate is injected (see fake-pool.ts) so this runs the REAL ledger
// with no Durable Object and no container runtime.
// ---------------------------------------------------------------------------

class FakeSandbox implements SandboxLike {
  destroyed = 0
  destroyImpl?: () => Promise<void>
  async runCode(): Promise<SandboxRunResult> {
    return { logs: { stdout: ["ok"], stderr: [] }, results: [] }
  }
  async writeFile(path: string): Promise<SandboxWriteResult> {
    return { success: true, path }
  }
  async readFile(path: string): Promise<SandboxReadResult> {
    return { success: true, path, content: "" }
  }
  async destroy(): Promise<void> {
    this.destroyed++
    if (this.destroyImpl) return this.destroyImpl()
  }
}

const AUTH = { Authorization: "Bearer test-key" }

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    AGENT_SANDBOX_KEY: "test-key",
    Sandbox: {} as Env["Sandbox"],
    SANDBOX_POOL: {} as Env["SANDBOX_POOL"],
    SNAPSHOTS: {
      get: async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }),
    } as unknown as Env["SNAPSHOTS"],
    // No waiting: these tests assert the refusal, which pool.test.ts covers
    // for the waiting path.
    SANDBOX_POOL_WAIT_MS: "0",
    ...overrides,
  }
}

function harness(pool: ReturnType<typeof makeFakePool>, env: Env = makeEnv()) {
  const sandbox = new FakeSandbox()
  const app = createApp({ resolveSandbox: () => sandbox, pool, sleep: noSleep })
  return { sandbox, fetch: (req: Request) => app.fetch(req, env) }
}

function execReq(sessionId: string, tenant?: string): Request {
  return new Request(`http://x/sessions/${sessionId}/exec`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json", ...(tenant ? { [TENANT_HEADER]: tenant } : {}) },
    body: JSON.stringify({ language: "python", code: "print(1)" }),
  })
}

describe("pool admission on the container routes", () => {
  it("lets a normal single run through untouched", async () => {
    // Acceptance criterion 3: normal imports and agent runs behave as before.
    const pool = makeFakePool()
    const { fetch } = harness(pool)
    const res = await fetch(execReq("s1", "user:1"))
    expect(res.status).toBe(200)
    expect(pool.admits).toEqual([{ sessionId: "s1", tenant: "user:1" }])
  })

  it("refuses with 503 pool_busy + Retry-After once the pool is full", async () => {
    const pool = makeFakePool({ maxTotal: 1, maxPerTenant: 5 })
    const { fetch } = harness(pool)
    expect((await fetch(execReq("s1", "user:1"))).status).toBe(200)

    const res = await fetch(execReq("s2", "user:2"))
    expect(res.status).toBe(503)
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe("pool_busy")
    // The message is shown to a person, so it must read as a wait, not a crash.
    expect(body.error.message).toMatch(/waiting for a sandbox/i)
  })

  it("tells a tenant at its own cap how many runs it is already holding", async () => {
    // Acceptance criterion 2: one user cannot hold more than the per-user cap,
    // and extra requests get a CLEAR message.
    const pool = makeFakePool({ maxTotal: 10, maxPerTenant: 2 })
    const { fetch } = harness(pool)
    expect((await fetch(execReq("a", "user:7"))).status).toBe(200)
    expect((await fetch(execReq("b", "user:7"))).status).toBe(200)

    const res = await fetch(execReq("c", "user:7"))
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe("pool_busy")
    expect(body.error.message).toMatch(/already have 2 sandbox runs/i)

    // Another user is unaffected — the cap is fairness, not a global stop.
    expect((await fetch(execReq("d", "user:8"))).status).toBe(200)
  })

  it("does not spend a second slot on the many execs of one session", async () => {
    const pool = makeFakePool({ maxTotal: 10, maxPerTenant: 1 })
    const { fetch } = harness(pool)
    // An import does inspect → parse → stat on the same container.
    for (let i = 0; i < 4; i++) {
      expect((await fetch(execReq("import-1", "user:1"))).status).toBe(200)
    }
    expect(pool.ledger.size).toBe(1)
    expect(pool.ledger.countForTenant("user:1")).toBe(1)
  })

  it("releases the slot on DELETE", async () => {
    const pool = makeFakePool({ maxTotal: 1, maxPerTenant: 1 })
    const { fetch } = harness(pool)
    expect((await fetch(execReq("s1", "user:1"))).status).toBe(200)
    expect((await fetch(execReq("s2", "user:2"))).status).toBe(503)

    const del = await fetch(new Request("http://x/sessions/s1", { method: "DELETE", headers: AUTH }))
    expect(del.status).toBe(200)
    expect(pool.releases).toEqual(["s1"])
    // The freed slot is immediately usable by the caller that was refused.
    expect((await fetch(execReq("s2", "user:2"))).status).toBe(200)
  })

  it("releases the slot even when container teardown reports a failure", async () => {
    // Holding the lease would punish the next caller for a container this one
    // has already stopped using.
    const pool = makeFakePool({ maxTotal: 1, maxPerTenant: 1 })
    const env = makeEnv()
    const sandbox = new FakeSandbox()
    sandbox.destroyImpl = async () => {
      throw new Error("container stop failed")
    }
    const app = createApp({ resolveSandbox: () => sandbox, pool, sleep: noSleep })
    const fetchIt = (req: Request) => app.fetch(req, env)

    expect((await fetchIt(execReq("s1", "user:1"))).status).toBe(200)
    const del = await fetchIt(new Request("http://x/sessions/s1", { method: "DELETE", headers: AUTH }))
    expect(del.status).toBe(500)
    expect(pool.releases).toEqual(["s1"])
    expect(pool.ledger.size).toBe(0)
  })

  it("gates fetch-artifact, which is the first container touch of an import", async () => {
    const pool = makeFakePool({ maxTotal: 1, maxPerTenant: 1 })
    const { fetch } = harness(pool)
    expect((await fetch(execReq("s1", "user:1"))).status).toBe(200)

    const res = await fetch(new Request("http://x/sessions/s2/fetch-artifact", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", [TENANT_HEADER]: "user:2" },
      body: JSON.stringify({ key: "k", path: "/workspace/input" }),
    }))
    expect(res.status).toBe(503)
    expect((await res.json() as { error: { code: string } }).error.code).toBe("pool_busy")
  })

  it("gates file writes too", async () => {
    const pool = makeFakePool({ maxTotal: 1, maxPerTenant: 1 })
    const { fetch } = harness(pool)
    expect((await fetch(execReq("s1", "user:1"))).status).toBe(200)

    const res = await fetch(new Request("http://x/sessions/s2/files", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json", [TENANT_HEADER]: "user:2" },
      body: JSON.stringify({ path: "/workspace/a.txt", contentBase64: "aGk=" }),
    }))
    expect(res.status).toBe(503)
  })

  it("buckets a caller that sends no tenant header under one shared budget", async () => {
    const pool = makeFakePool({ maxTotal: 10, maxPerTenant: 1 })
    const { fetch } = harness(pool)
    expect((await fetch(execReq("s1"))).status).toBe(200)
    expect((await fetch(execReq("s2"))).status).toBe(503)
    expect(pool.admits[0]).toEqual({ sessionId: "s1", tenant: "anonymous" })
  })

  it("still rejects an unauthenticated request before it can take a slot", async () => {
    const pool = makeFakePool()
    const { fetch } = harness(pool)
    const res = await fetch(new Request("http://x/sessions/s1/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "python", code: "print(1)" }),
    }))
    expect(res.status).toBe(401)
    expect(pool.admits).toEqual([])
  })

  it("does not take a slot for a request that fails validation", async () => {
    const pool = makeFakePool()
    const { fetch } = harness(pool)
    const res = await fetch(new Request("http://x/sessions/s1/exec", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ language: "ruby", code: "puts 1" }),
    }))
    expect(res.status).toBe(400)
    expect(pool.admits).toEqual([])
  })
})
