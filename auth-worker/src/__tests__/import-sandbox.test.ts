import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { IMPORT_INSPECT_PROGRAM } from "../routes/import-sandbox"
import { jwtFor, seedUser } from "./helpers/db"

const PROJECT_ID = "sandbox-import-project"

class FakeBucket {
  store = new Map<string, Uint8Array>()
  async put(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, new Uint8Array(value))
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

async function seedOwner(): Promise<string> {
  await seedUser(1, "sandbox-owner")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, 'Sandbox import', 1)",
  ).bind(PROJECT_ID).run()
  return jwtFor("sandbox-owner")
}

function testEnv(bucket?: FakeBucket): typeof env {
  return Object.assign(Object.create(env), {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_BASE_URL: "http://model.test/api/v1",
    AGENT_SANDBOX_URL: "http://sandbox.test",
    AGENT_SANDBOX_KEY: "sandbox-key",
    SNAPSHOTS: bucket,
    AI_BUDGET_ENFORCE: "false",
  })
}

function proposal() {
  return {
    category: "scripture",
    confidence: 0.96,
    explanation: "Custom scripture records with explicit headings and verses.",
    profileName: "Legacy scripture parser",
    inputFormat: "legacy-binary",
    language: "python",
    code: "import json\njson.dump({'units': []}, open('/workspace/result.json', 'w'))",
  }
}

afterEach(() => vi.restoreAllMocks())

describe("POST /api/v1/import/parse/:projectId", () => {
  it("inspects long-tail document containers without executing imported content", () => {
    expect(IMPORT_INSPECT_PROGRAM).toContain("from pypdf import PdfReader")
    expect(IMPORT_INSPECT_PROGRAM).toContain("import xlrd")
    expect(IMPORT_INSPECT_PROGRAM).toContain("import olefile")
    expect(IMPORT_INSPECT_PROGRAM).toContain(".xhtml")
    expect(IMPORT_INSPECT_PROGRAM).toContain("entry.file_size <= 8 * 1024 * 1024")
  })

  it("runs generated parsing only in the sandbox, validates units, and cleans temporary state", async () => {
    const jwt = await seedOwner()
    const bucket = new FakeBucket()
    let execCount = 0
    const upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("/fetch-artifact")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer sandbox-key" })
        return new Response(JSON.stringify({ ok: true, bytes: 4 }), { status: 200 })
      }
      if (url.endsWith("/exec")) {
        execCount++
        const output = execCount === 1
          ? { ok: true, stdout: JSON.stringify({ isZip: true, zipMembers: ["custom/data.xml"] }), stderr: "", durationMs: 2 }
          : execCount === 3
            ? { ok: true, stdout: "512", stderr: "", durationMs: 1 }
            : { ok: true, stdout: "", stderr: "", durationMs: 3 }
        return new Response(JSON.stringify(output), { status: 200 })
      }
      if (url.includes("model.test")) {
        const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        expect(request.messages[0].content).toContain("networkless sandbox")
        expect(request.messages[1].content).toContain("<untrusted-import-input>")
        expect(request.messages[1].content).toContain("<untrusted-file-inspection>")
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(proposal()) } }],
          usage: { cost: 0.002 },
        }), { status: 200 })
      }
      if (url.includes("/files?")) {
        return new Response(JSON.stringify({ units: [
          { sourceText: "Creation", type: "heading", globalReferences: ["GEN 1:1"] },
          { sourceText: "In the beginning", targetText: "Au commencement", type: "verse", globalReferences: ["GEN 1:1"] },
        ] }), { status: 200 })
      }
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 })
      throw new Error(`Unexpected fetch ${url}`)
    })

    const response = await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/octet-stream",
        "X-Artifact-Name": "legacy.bin",
      },
      body: new Uint8Array([0, 1, 2, 3]),
    }, testEnv(bucket))

    expect(response.status).toBe(200)
    const body = await response.json() as {
      units: Array<Record<string, unknown>>
      classification: { recipe: { strategy: string; program: { source: string; sha256: string } } }
    }
    expect(body.units).toHaveLength(2)
    expect(body.units[0]).toMatchObject({ type: "heading", globalReferences: ["GEN 1:1"] })
    expect(body.classification.recipe).toMatchObject({
      strategy: "sandbox-program",
      program: { source: proposal().code },
    })
    expect(body.classification.recipe.program.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(bucket.store.size).toBe(0)
    expect(upstream.mock.calls.some(([url, init]) => String(url).includes("/sessions/import-") && init?.method === "DELETE")).toBe(true)
  })

  it("repairs an invalid parser result once, then returns only validated units", async () => {
    const jwt = await seedOwner()
    const bucket = new FakeBucket()
    let modelCalls = 0
    let parserRuns = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("/fetch-artifact")) {
        return new Response(JSON.stringify({ ok: true, bytes: 4 }), { status: 200 })
      }
      if (url.endsWith("/exec")) {
        const request = JSON.parse(String(init?.body)) as { code: string }
        if (request.code.includes("size = path.stat().st_size")) {
          return new Response(JSON.stringify({
            ok: true,
            stdout: JSON.stringify({ sizeBytes: 4, isZip: false, textSample: "legacy" }),
            stderr: "",
            durationMs: 1,
          }), { status: 200 })
        }
        if (request.code.includes("stat().st_size")) {
          return new Response(JSON.stringify({ ok: true, stdout: "128", stderr: "", durationMs: 1 }), { status: 200 })
        }
        parserRuns++
        return new Response(JSON.stringify({ ok: true, stdout: "", stderr: "", durationMs: 1 }), { status: 200 })
      }
      if (url.includes("model.test")) {
        modelCalls++
        const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        if (modelCalls === 2) {
          expect(request.messages[1].content).toContain("<untrusted-previous-error>")
          expect(request.messages[1].content).toContain("failed validation")
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(proposal()) } }],
          usage: { cost: 0.001 },
        }), { status: 200 })
      }
      if (url.includes("/files?")) {
        return new Response(modelCalls === 1
          ? JSON.stringify({ units: [] })
          : JSON.stringify({ units: [{ sourceText: "Recovered record", type: "text" }] }),
        { status: 200 })
      }
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 })
      throw new Error(`Unexpected fetch ${url}`)
    })

    const response = await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/octet-stream",
        "X-Artifact-Name": "repair.odd",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    }, testEnv(bucket))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      units: [{ sourceText: "Recovered record", type: "text" }],
    })
    expect(modelCalls).toBe(2)
    expect(parserRuns).toBe(2)
    expect(bucket.store.size).toBe(0)
  })

  it("fails closed before upload when the isolated sandbox is not configured", async () => {
    const jwt = await seedOwner()
    const bucket = new FakeBucket()
    const response = await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "X-Artifact-Name": "legacy.bin" },
      body: new Uint8Array([1]),
    }, Object.assign(Object.create(testEnv(bucket)), {
      AGENT_SANDBOX_URL: undefined,
      AGENT_SANDBOX_KEY: undefined,
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: "import_parser_unavailable" })
    expect(bucket.store.size).toBe(0)
  })

  it("rejects a declared oversized upload before buffering or contacting dependencies", async () => {
    const jwt = await seedOwner()
    const bucket = new FakeBucket()
    const upstream = vi.spyOn(globalThis, "fetch")
    const response = await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Length": String(25 * 1024 * 1024 + 1),
        "X-Artifact-Name": "oversized.odd",
      },
      body: new Uint8Array([1]),
    }, testEnv(bucket))

    expect(response.status).toBe(413)
    expect(bucket.store.size).toBe(0)
    expect(upstream).not.toHaveBeenCalled()
  })

  it("checks project-lead authorization before revealing sandbox configuration", async () => {
    await seedOwner()
    await seedUser(2, "sandbox-outsider")
    const jwt = await jwtFor("sandbox-outsider")
    const upstream = vi.spyOn(globalThis, "fetch")
    const response = await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "X-Artifact-Name": "legacy.bin" },
      body: new Uint8Array([1]),
    }, Object.assign(Object.create(testEnv(new FakeBucket())), {
      AGENT_SANDBOX_URL: undefined,
      AGENT_SANDBOX_KEY: undefined,
    }))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "project_lead_required" })
    expect(upstream).not.toHaveBeenCalled()
  })

  // ── AQU-1848: pool saturation ────────────────────────────────────────────
  //
  // The sandbox pool is account-wide and small. When it is full the sandbox
  // answers `pool_busy`, and the import route must say "try again in a moment"
  // (503 + Retry-After) rather than the generic 502 "this file cannot be
  // imported" — and must not burn LLM credits retrying against a full pool.

  it("sends the per-user pool tenant on every sandbox call", async () => {
    const jwt = await seedOwner()
    const bucket = new FakeBucket()
    // Only calls that may START a container need the tenant; the teardown
    // DELETE releases by session id and never admits, so it carries none.
    const tenants: Array<string | undefined> = []
    let destroyTenant: string | undefined | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("sandbox.test")) {
        const headers = new Headers(init?.headers as HeadersInit)
        const tenant = headers.get("X-Sandbox-Tenant") ?? undefined
        if (init?.method === "DELETE") destroyTenant = tenant
        else tenants.push(tenant)
      }
      if (url.includes("/fetch-artifact")) {
        return new Response(JSON.stringify({ ok: true, bytes: 4 }), { status: 200 })
      }
      if (url.endsWith("/exec")) {
        return new Response(JSON.stringify({
          ok: true,
          stdout: JSON.stringify({ isZip: false }),
          stderr: "",
          durationMs: 1,
        }), { status: 200 })
      }
      if (url.includes("model.test")) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(proposal()) } }],
          usage: { cost: 0.001 },
        }), { status: 200 })
      }
      if (url.includes("/files?")) {
        return new Response(JSON.stringify({ units: [{ sourceText: "x", type: "verse" }] }), { status: 200 })
      }
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }), { status: 200 })
      throw new Error(`Unexpected fetch ${url}`)
    })

    await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/octet-stream",
        "X-Artifact-Name": "legacy.bin",
      },
      body: new Uint8Array([0, 1, 2, 3]),
    }, testEnv(bucket))

    // Seeded user id 1 — the cap is counted per user, so one project lead
    // cannot hold every container with back-to-back imports.
    // fetch-artifact, the inspect exec, the parser exec, the size exec and the
    // result read all go out under the same tenant.
    expect(tenants.length).toBeGreaterThanOrEqual(4)
    expect(new Set(tenants)).toEqual(new Set(["user:1"]))
    expect(destroyTenant).toBeUndefined()
  })

  it("answers 503 sandbox_busy with Retry-After when the pool is saturated", async () => {
    const jwt = await seedOwner()
    const bucket = new FakeBucket()
    let modelCalls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("model.test")) {
        modelCalls++
        throw new Error("the model must not be called when no sandbox is free")
      }
      if (url.includes("/fetch-artifact")) {
        // What agent-worker returns once the pool (or this tenant's share of
        // it) is full — see agent-worker/src/app.ts `poolBusy`.
        return new Response(JSON.stringify({
          error: { code: "pool_busy", message: "Waiting for a sandbox — every sandbox is busy right now. Please try again in a moment." },
        }), { status: 503, headers: { "Retry-After": "3" } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const response = await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/octet-stream",
        "X-Artifact-Name": "legacy.bin",
      },
      body: new Uint8Array([0, 1, 2, 3]),
    }, testEnv(bucket))

    expect(response.status).toBe(503)
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
    const body = await response.json() as { error: string; message: string }
    expect(body.error).toBe("sandbox_busy")
    // The message must read as a wait, not as a broken file.
    expect(body.message).toMatch(/waiting for a sandbox/i)
    expect(modelCalls).toBe(0)
    // The staged upload is still cleaned up on the way out.
    expect(bucket.store.size).toBe(0)
  })

  it("surfaces the tenant's own cap as a clear message instead of retrying the model", async () => {
    const jwt = await seedOwner()
    const bucket = new FakeBucket()
    let modelCalls = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes("model.test")) {
        modelCalls++
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(proposal()) } }],
          usage: { cost: 0.001 },
        }), { status: 200 })
      }
      if (url.includes("/fetch-artifact")) {
        return new Response(JSON.stringify({ ok: true, bytes: 4 }), { status: 200 })
      }
      if (url.endsWith("/exec")) {
        return new Response(JSON.stringify({
          error: { code: "pool_busy", message: "You already have 3 sandbox runs in flight. Wait for one to finish and try again." },
        }), { status: 503 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const response = await app.request(`/api/v1/import/parse/${PROJECT_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/octet-stream",
        "X-Artifact-Name": "legacy.bin",
      },
      body: new Uint8Array([0, 1, 2, 3]),
    }, testEnv(bucket))

    expect(response.status).toBe(503)
    const body = await response.json() as { error: string; message: string }
    expect(body.error).toBe("sandbox_busy")
    expect(body.message).toMatch(/already have 3 sandbox runs/i)
    // The inspect exec is refused before any model call, so a user at their cap
    // never pays for an LLM round trip.
    expect(modelCalls).toBe(0)
  })
})
