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
})
