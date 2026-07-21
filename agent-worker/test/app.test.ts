import { describe, it, expect, beforeEach } from "vitest"
import { createApp } from "../src/app"
import type { Env } from "../src/types"
import type {
  SandboxLike,
  SandboxRunResult,
  SandboxReadResult,
  SandboxWriteResult,
} from "../src/sandbox"

// ---------------------------------------------------------------------------
// Test doubles — a fake sandbox + fake R2 so no Docker/container is needed.
// ---------------------------------------------------------------------------

interface Recorded {
  runCode: Array<{ code: string; language?: string }>
  writeFile: Array<{ path: string; content: string; encoding?: string }>
  readFile: Array<{ path: string; encoding?: string }>
  destroyed: number
}

class FakeSandbox implements SandboxLike {
  calls: Recorded = { runCode: [], writeFile: [], readFile: [], destroyed: 0 }
  runResult: SandboxRunResult = { logs: { stdout: [], stderr: [] }, results: [] }
  readResult: SandboxReadResult | Error = {
    success: true,
    path: "/workspace/x",
    content: "",
  }
  runImpl?: (code: string) => Promise<SandboxRunResult>
  destroyImpl?: () => Promise<void>

  async runCode(code: string, options?: { language?: "python" | "javascript" | "typescript" }): Promise<SandboxRunResult> {
    this.calls.runCode.push({ code, language: options?.language })
    if (this.runImpl) return this.runImpl(code)
    return this.runResult
  }
  async writeFile(path: string, content: string, options?: { encoding?: string }): Promise<SandboxWriteResult> {
    this.calls.writeFile.push({ path, content, encoding: options?.encoding })
    return { success: true, path }
  }
  async readFile(path: string, options?: { encoding?: string }): Promise<SandboxReadResult> {
    this.calls.readFile.push({ path, encoding: options?.encoding })
    if (this.readResult instanceof Error) throw this.readResult
    return this.readResult
  }
  async destroy(): Promise<void> {
    this.calls.destroyed++
    if (this.destroyImpl) return this.destroyImpl()
  }
}

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    AGENT_SANDBOX_KEY: "test-key",
    Sandbox: {} as Env["Sandbox"],
    SNAPSHOTS: {
      get: async () => null,
    } as unknown as Env["SNAPSHOTS"],
    ...overrides,
  }
}

function harness(sandbox: FakeSandbox, env: Env = makeEnv()) {
  const app = createApp({ resolveSandbox: () => sandbox })
  return (req: Request) => app.fetch(req, env)
}

const AUTH = { Authorization: "Bearer test-key" }

function b64(s: string): string {
  return btoa(s)
}

interface JsonBody {
  ok?: boolean
  stdout?: string
  stderr?: string
  resultJson?: string
  durationMs?: number
  truncated?: boolean
  bytes?: number
  error?: { code: string; message: string }
}

async function readJson(res: Response): Promise<JsonBody> {
  return (await res.json()) as JsonBody
}

// ---------------------------------------------------------------------------
// Health + auth
// ---------------------------------------------------------------------------

describe("health + auth", () => {
  let sandbox: FakeSandbox
  beforeEach(() => {
    sandbox = new FakeSandbox()
  })

  it("GET /health returns ok with no auth", async () => {
    const res = await harness(sandbox)(new Request("http://x/health"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("401s when the bearer token is missing", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", { method: "POST", body: "{}" }),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    })
  })

  it("401s when the bearer token is wrong", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: { Authorization: "Bearer nope" },
        body: "{}",
      }),
    )
    expect(res.status).toBe(401)
  })

  // authz-m1: the constant-time compare (SHA-256 digests, no early exit) must
  // still reject a wrong key — including a same-length one that a naive
  // byte-compare would also reject but with a timing tell.
  it("401s on a same-length wrong bearer token (constant-time compare)", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: { Authorization: "Bearer test-keX" }, // same length as "test-key"... +1, still wrong
        body: "{}",
      }),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    })
  })

  it("401s on files GET without auth", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files?path=a.txt"),
    )
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe("POST /sessions/:id/exec", () => {
  let sandbox: FakeSandbox
  beforeEach(() => {
    sandbox = new FakeSandbox()
  })

  it("shapes a successful python run", async () => {
    sandbox.runResult = {
      logs: { stdout: ["hello\n"], stderr: [] },
      results: [{ json: { answer: 42 } }],
    }
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ language: "python", code: "print('hello')" }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.ok).toBe(true)
    expect(body.stdout).toBe("hello\n")
    expect(body.stderr).toBe("")
    expect(body.resultJson).toBe(JSON.stringify({ answer: 42 }))
    expect(typeof body.durationMs).toBe("number")
    expect(sandbox.calls.runCode[0].language).toBe("python")
  })

  it("maps js → javascript language", async () => {
    await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ language: "js", code: "1+1" }),
      }),
    )
    expect(sandbox.calls.runCode[0].language).toBe("javascript")
  })

  it("reports ok:false with an error tail when the interpreter errors", async () => {
    sandbox.runResult = {
      logs: { stdout: [], stderr: ["boom\n"] },
      error: { name: "ValueError", message: "bad", traceback: ["line 1"] },
      results: [],
    }
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ language: "python", code: "raise ValueError()" }),
      }),
    )
    const body = await readJson(res)
    expect(body.ok).toBe(false)
    expect(body.stderr).toContain("ValueError: bad")
    expect(body.stderr).toContain("boom")
  })

  it("caps stdout at 64KB and flags truncation", async () => {
    const big = "a".repeat(70 * 1024)
    sandbox.runResult = { logs: { stdout: [big], stderr: [] }, results: [] }
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ language: "js", code: "x" }),
      }),
    )
    const body = await readJson(res)
    expect(body.truncated).toBe(true)
    expect(new TextEncoder().encode(body.stdout ?? "").length).toBeLessThanOrEqual(64 * 1024)
  })

  it("returns {ok:false, stderr:'timeout'} when execution exceeds the timeout", async () => {
    sandbox.runImpl = () => new Promise<SandboxRunResult>(() => {})
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ language: "python", code: "sleep", timeoutMs: 20 }),
      }),
    )
    const body = await readJson(res)
    expect(body.ok).toBe(false)
    expect(body.stderr).toBe("timeout")
  })

  it("400s on an invalid language", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ language: "ruby", code: "x" }),
      }),
    )
    expect(res.status).toBe(400)
    expect((await readJson(res)).error?.code).toBe("validation_failed")
  })

  it("400s when code is missing", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ language: "js" }),
      }),
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// files put
// ---------------------------------------------------------------------------

describe("POST /sessions/:id/files", () => {
  let sandbox: FakeSandbox
  beforeEach(() => {
    sandbox = new FakeSandbox()
  })

  it("writes a file (base64) under the resolved workspace path", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ path: "data/foo.txt", contentBase64: b64("hi") }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(sandbox.calls.writeFile[0]).toEqual({
      path: "/workspace/data/foo.txt",
      content: b64("hi"),
      encoding: "base64",
    })
  })

  it("rejects path traversal without touching the sandbox", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ path: "../etc/passwd", contentBase64: b64("x") }),
      }),
    )
    expect(res.status).toBe(400)
    expect((await readJson(res)).error?.code).toBe("validation_failed")
    expect(sandbox.calls.writeFile).toHaveLength(0)
  })

  it("rejects absolute paths outside /workspace", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ path: "/etc/passwd", contentBase64: b64("x") }),
      }),
    )
    expect(res.status).toBe(400)
    expect(sandbox.calls.writeFile).toHaveLength(0)
  })

  it("413s when the decoded file exceeds the size cap", async () => {
    const huge = b64("a".repeat(26 * 1024 * 1024))
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ path: "big.bin", contentBase64: huge }),
      }),
    )
    expect(res.status).toBe(413)
    expect((await readJson(res)).error?.code).toBe("too_large")
  })
})

// ---------------------------------------------------------------------------
// files get
// ---------------------------------------------------------------------------

describe("GET /sessions/:id/files", () => {
  let sandbox: FakeSandbox
  beforeEach(() => {
    sandbox = new FakeSandbox()
  })

  it("returns raw bytes as octet-stream", async () => {
    sandbox.readResult = {
      success: true,
      path: "/workspace/out.bin",
      content: b64("payload"),
      encoding: "base64",
    }
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files?path=out.bin", { headers: AUTH }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/octet-stream")
    expect(await res.text()).toBe("payload")
    expect(sandbox.calls.readFile[0]).toEqual({ path: "/workspace/out.bin", encoding: "base64" })
  })

  it("404s when the file is missing (success:false)", async () => {
    sandbox.readResult = { success: false, path: "/workspace/x", content: "" }
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files?path=missing.txt", { headers: AUTH }),
    )
    expect(res.status).toBe(404)
    expect((await readJson(res)).error?.code).toBe("not_found")
  })

  it("404s when the sandbox throws a not-found error", async () => {
    sandbox.readResult = new Error("ENOENT: no such file")
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files?path=missing.txt", { headers: AUTH }),
    )
    expect(res.status).toBe(404)
  })

  it("400s on path traversal", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files?path=..%2Fescape", { headers: AUTH }),
    )
    expect(res.status).toBe(400)
    expect(sandbox.calls.readFile).toHaveLength(0)
  })

  it("400s when path query param is absent", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/files", { headers: AUTH }),
    )
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// fetch-artifact
// ---------------------------------------------------------------------------

describe("POST /sessions/:id/fetch-artifact", () => {
  let sandbox: FakeSandbox
  beforeEach(() => {
    sandbox = new FakeSandbox()
  })

  it("copies an R2 object into the container", async () => {
    const payload = new TextEncoder().encode("csv,data\n1,2\n")
    const env = makeEnv({
      SNAPSHOTS: {
        get: async (key: string) =>
          key === "artifacts/p1/a1"
            ? { arrayBuffer: async () => payload.buffer.slice(0) }
            : null,
      } as unknown as Env["SNAPSHOTS"],
    })
    const res = await harness(sandbox, env)(
      new Request("http://x/sessions/s1/fetch-artifact", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ key: "artifacts/p1/a1", path: "input.csv" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, bytes: payload.length })
    const written = sandbox.calls.writeFile[0]
    expect(written.path).toBe("/workspace/input.csv")
    expect(written.encoding).toBe("base64")
    expect(atob(written.content)).toBe("csv,data\n1,2\n")
  })

  it("404s when the artifact does not exist", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/fetch-artifact", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ key: "nope", path: "input.csv" }),
      }),
    )
    expect(res.status).toBe(404)
    expect((await readJson(res)).error?.code).toBe("not_found")
    expect(sandbox.calls.writeFile).toHaveLength(0)
  })

  it("400s on path traversal before hitting R2", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1/fetch-artifact", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ key: "k", path: "../../secret" }),
      }),
    )
    expect(res.status).toBe(400)
    expect(sandbox.calls.writeFile).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe("DELETE /sessions/:id", () => {
  let sandbox: FakeSandbox
  beforeEach(() => {
    sandbox = new FakeSandbox()
  })

  it("destroys the container", async () => {
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1", { method: "DELETE", headers: AUTH }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(sandbox.calls.destroyed).toBe(1)
  })

  it("is idempotent when the container is already gone", async () => {
    sandbox.destroyImpl = async () => {
      throw new Error("container not found")
    }
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1", { method: "DELETE", headers: AUTH }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("500s on an unexpected destroy failure", async () => {
    sandbox.destroyImpl = async () => {
      throw new Error("network blip talking to container")
    }
    const res = await harness(sandbox)(
      new Request("http://x/sessions/s1", { method: "DELETE", headers: AUTH }),
    )
    expect(res.status).toBe(500)
    expect((await readJson(res)).error?.code).toBe("exec_failed")
  })
})
